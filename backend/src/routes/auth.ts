/**
 * Auth routes: passkey registration and sign-in, logout and current user.
 * Implemented per `contracts/openapi.yaml`.
 *
 * Sign-in is username-less: login/options returns assertion options with no
 * allowCredentials (the authenticator only surfaces discoverable
 * credentials), bound to an opaque single-use requestId; login/verify
 * consumes the requestId's challenge and resolves the user from the
 * asserted credential (FR-002).
 *
 * Registration is token-gated only (FR-001/FR-002): every request must
 * carry a valid secret token — an invite token (new users, or
 * re-enrollment after an admin passkey reset) or the bootstrap enrollment
 * token (the provisioned admin's first passkey). A username alone is
 * always refused with a generic error, and responses never reveal account
 * existence or passkey state without a valid token (FR-005). Redeeming an
 * invite for a username that already exists attaches the passkey to that
 * account when bucket/prefix/isAdmin match and the account holds zero
 * discoverable credentials (FR-004); otherwise the claim is refused
 * without re-scoping. Every registered passkey is discoverable;
 * re-enrolling an account with only legacy non-discoverable credentials
 * deletes those legacy rows.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Database } from "bun:sqlite";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AppConfig } from "../config";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  SESSION_COOKIE_NAME,
  sessionCookie,
  validateSession,
} from "../auth/sessions";
import {
  createCredential,
  createUser,
  deleteLegacyCredentialsByUser,
  getCredentialById,
  getInviteByToken,
  getUserById,
  getUserByUsername,
  listDiscoverableCredentialsByUser,
  markInviteClaimed,
  updateCredentialCounter,
} from "../db/repository";
import type { Invite, User } from "../db/repository";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyLogin,
  verifyRegistration,
} from "../auth/webauthn";
import type { ChallengeStore } from "../auth/webauthn";
import { RP_NAME } from "../auth/webauthn";
import type { ServerEnv } from "../server";

/** Dependencies for {@link authRoutes}. */
export interface AuthRouteDeps {
  config: AppConfig;
  db: Database;
  challenges: ChallengeStore;
}

/** A parsed JSON request body, or an error response to return. */
type ParsedBody =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: Response };

/** The user shape returned by the API (contract `User` schema). */
export interface ApiUser {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
}

/** A problem with an invite, or null when it can be used. */
interface InviteProblem {
  message: string;
  code: string;
}

/** The secret-free user shape sent to clients. */
function toApiUser(user: User): ApiUser {
  return {
    id: user.id,
    username: user.username,
    bucket: user.bucket,
    prefix: user.prefix,
    isAdmin: user.isAdmin,
  };
}

/**
 * Build a JSON error response.
 *
 * @param c - Hono context
 * @param status - HTTP status
 * @param message - human-readable message
 * @param code - machine-readable error code
 * @returns a JSON error response
 */
function jsonError(
  c: Context<ServerEnv>,
  status: 400 | 401 | 404,
  message: string,
  code: string,
): Response {
  return c.json({ error: message, code }, status);
}

/**
 * Parse a JSON request body.
 *
 * @param c - Hono context
 * @returns the parsed object, or an error response for malformed JSON
 */
async function parseBody(c: Context<ServerEnv>): Promise<ParsedBody> {
  try {
    const value = (await c.req.json()) as Record<string, unknown>;
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      error: jsonError(c, 400, "Invalid JSON body", "bad_request"),
    };
  }
}

/**
 * Validate an invite for registration: it must exist, be unclaimed and
 * unexpired.
 *
 * @param invite - invite row or null
 * @param now - reference time
 * @returns a problem description, or null when the invite is usable
 */
function inviteProblem(invite: Invite | null, now: Date): InviteProblem | null {
  if (!invite) {
    return { message: "Invite not found", code: "invite_not_found" };
  }
  if (invite.claimedByUserId !== null) {
    return {
      message: "This invite has already been used",
      code: "invite_claimed",
    };
  }
  if (Date.parse(invite.expiresAt) <= now.getTime()) {
    return { message: "This invite has expired", code: "invite_expired" };
  }
  return null;
}

/**
 * Extract the credential id from a response body, or null when absent.
 *
 * @param response - the credential field from the request body
 * @returns the credential id string or null
 */
function credentialIdOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Compare two strings in constant time by comparing the SHA-256 digests of
 * both inputs. Digest lengths are always equal (32 bytes), so
 * `timingSafeEqual` never throws, and the comparison reveals nothing about
 * the length of the secrets (FR-003).
 *
 * @param a - first string
 * @param b - second string
 * @returns true when the digests match
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Create a session for a user and set the session cookie on the response.
 *
 * @param c - Hono context
 * @param config - application configuration
 * @param db - database connection
 * @param userId - id of the signed-in user
 */
function startSession(
  c: Context<ServerEnv>,
  config: AppConfig,
  db: Database,
  userId: string,
): void {
  const { token } = createSession(db, userId);
  c.header(
    "Set-Cookie",
    sessionCookie(token, {
      secure: config.nodeEnv === "production",
      maxAgeSeconds: config.sessionTtlDays * 24 * 60 * 60,
    }),
  );
}

/**
 * Create the auth route module mounted under /auth.
 *
 * @param deps - configuration, database and challenge store
 * @returns a Hono app with the auth routes
 */
export function authRoutes(deps: AuthRouteDeps): Hono<ServerEnv> {
  const { config, db, challenges } = deps;

  const app = new Hono<ServerEnv>();

  app.post("/register/options", async (c) => {
    challenges.sweep();
    const body = await parseBody(c);
    if (!body.ok) return body.error;
    const token = body.value.token;
    if (typeof token !== "string" || token === "") {
      return jsonError(c, 400, "An invite token is required", "bad_request");
    }

    // (a) Invite semantics: the invite defines the claim target.
    const invite = getInviteByToken(db, token);
    if (invite) {
      const problem = inviteProblem(invite, new Date());
      if (problem) return jsonError(c, 400, problem.message, problem.code);

      const existing = getUserByUsername(db, invite.username);
      if (existing) {
        // Attach path: the passkey will attach to the existing account.
        // The zero-credentials gate is the attach invariant (FR-004);
        // legacy-only accounts are still attachable.
        if (listDiscoverableCredentialsByUser(db, existing.id).length > 0) {
          return jsonError(
            c,
            400,
            "This account already has a passkey - sign in with it",
            "user_has_passkey",
          );
        }
        const options = await generateRegistrationOptions({
          rpId: config.webauthn.rpId,
          rpName: RP_NAME,
          username: existing.username,
          userId: existing.id,
          userDisplayName: existing.username,
        });
        challenges.putRegistration(`reg:${token}`, {
          challenge: options.challenge,
          username: existing.username,
          inviteToken: token,
          userId: existing.id,
          createdAt: Date.now(),
        });
        return c.json(
          {
            options,
            username: existing.username,
            bucket: invite.bucket,
            prefix: invite.prefix,
          },
          200,
        );
      }

      // New user: pre-assign the user id so the WebAuthn userHandle equals
      // the persisted user id; createUser reuses it at verify time.
      const userId = randomUUID();
      const options = await generateRegistrationOptions({
        rpId: config.webauthn.rpId,
        rpName: RP_NAME,
        username: invite.username,
        userId,
        userDisplayName: invite.username,
      });
      challenges.putRegistration(`reg:${token}`, {
        challenge: options.challenge,
        username: invite.username,
        inviteToken: token,
        userId,
        createdAt: Date.now(),
      });
      return c.json(
        {
          options,
          username: invite.username,
          bucket: invite.bucket,
          prefix: invite.prefix,
        },
        200,
      );
    }

    // (b) Bootstrap semantics: the configured enrollment token gates the
    // provisioned admin's first passkey (FR-003, R2).
    const enrollmentToken = config.bootstrapAdmin.enrollmentToken;
    if (enrollmentToken !== null && constantTimeEquals(token, enrollmentToken)) {
      const username = config.bootstrapAdmin.username;
      if (username === null) {
        return jsonError(c, 400, "Invite not found", "invite_not_found");
      }
      const user = getUserByUsername(db, username);
      // A missing bootstrap user yields the same generic refusal as an
      // unknown invite: the response never reveals a bootstrap token
      // exists (FR-005).
      if (!user) {
        return jsonError(c, 400, "Invite not found", "invite_not_found");
      }
      if (listDiscoverableCredentialsByUser(db, user.id).length > 0) {
        return jsonError(
          c,
          400,
          "This account already has a passkey - sign in with it",
          "user_has_passkey",
        );
      }
      const options = await generateRegistrationOptions({
        rpId: config.webauthn.rpId,
        rpName: RP_NAME,
        username: user.username,
        userId: user.id,
        userDisplayName: user.username,
      });
      // Namespaced challenge key so the verify-time binding check
      // (challenge.inviteToken === token) works uniformly.
      challenges.putRegistration(`bootstrap:${token}`, {
        challenge: options.challenge,
        username: user.username,
        inviteToken: token,
        userId: user.id,
        createdAt: Date.now(),
      });
      return c.json(
        {
          options,
          username: user.username,
          bucket: user.bucket,
          prefix: user.prefix,
        },
        200,
      );
    }

    // (c) Generic refusal: identical for unknown invites and wrong
    // bootstrap tokens (SC-002). Account existence and passkey state are
    // never revealed without a valid token (FR-005).
    return jsonError(c, 400, "Invite not found", "invite_not_found");
  });

  app.post("/register/verify", async (c) => {
    challenges.sweep();
    const body = await parseBody(c);
    if (!body.ok) return body.error;
    const credential = body.value.credential;
    const token = body.value.token;
    if (typeof token !== "string" || token === "") {
      return jsonError(c, 400, "An invite token is required", "bad_request");
    }

    // (a) Invite semantics: username, bucket and prefix come from the
    // invite; the claim attaches to an existing account when the attach
    // invariant holds (FR-004).
    const invite = getInviteByToken(db, token);
    if (invite) {
      // Re-check the invite (claimed/expired) so a challenge obtained
      // before the invite was consumed elsewhere is refused (T013).
      const problem = inviteProblem(invite, new Date());
      if (problem) return jsonError(c, 400, problem.message, problem.code);

      const challenge = challenges.takeRegistration(`reg:${token}`);
      if (!challenge || challenge.inviteToken !== token) {
        return jsonError(
          c,
          400,
          "Registration session expired, please try again",
          "challenge_expired",
        );
      }

      try {
        const data = await verifyRegistration({
          response: credential as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: config.webauthn.origin,
          expectedRPID: config.webauthn.rpId,
        });
        if (getCredentialById(db, data.id)) {
          return jsonError(
            c,
            400,
            "This passkey is already registered to another account",
            "credential_exists",
          );
        }

        const existing = getUserByUsername(db, invite.username);
        if (existing) {
          // Attach gate: the claim attaches only when the account still
          // holds zero discoverable passkeys and the invite's scope and
          // privilege match the account exactly (FR-004). Never re-scope
          // or re-privilege; never create a credential on a mismatch.
          const zeroDiscoverable =
            listDiscoverableCredentialsByUser(db, existing.id).length === 0;
          const scopeMatches =
            invite.bucket === existing.bucket &&
            invite.prefix === existing.prefix &&
            invite.isAdmin === existing.isAdmin;
          if (!zeroDiscoverable || !scopeMatches) {
            return jsonError(
              c,
              400,
              "This invite cannot be attached to the existing account",
              "attach_refused",
            );
          }
          createCredential(db, {
            id: data.id,
            userId: existing.id,
            publicKey: data.publicKey,
            counter: data.counter,
            transports: data.transports,
            discoverable: true,
          });
          // Legacy non-discoverable credentials can never work in the
          // username-less flow: delete them on re-enrollment.
          deleteLegacyCredentialsByUser(db, existing.id);
          markInviteClaimed(db, invite.id, existing.id);
          startSession(c, config, db, existing.id);
          return c.json({ user: toApiUser(existing) }, 200);
        }

        const user = createUser(db, {
          id: challenge.userId,
          username: invite.username,
          bucket: invite.bucket,
          prefix: invite.prefix,
          isAdmin: invite.isAdmin,
        });
        createCredential(db, {
          id: data.id,
          userId: user.id,
          publicKey: data.publicKey,
          counter: data.counter,
          transports: data.transports,
          discoverable: true,
        });
        markInviteClaimed(db, invite.id, user.id);
        startSession(c, config, db, user.id);
        return c.json({ user: toApiUser(user) }, 200);
      } catch {
        return jsonError(c, 400, "Registration failed", "registration_failed");
      }
    }

    // (b) Bootstrap semantics: the token is re-checked in constant time
    // and the zero-credentials gate is re-applied at verify time, so a
    // challenge obtained before the admin enrolled elsewhere is refused
    // (T013).
    const enrollmentToken = config.bootstrapAdmin.enrollmentToken;
    if (enrollmentToken !== null && constantTimeEquals(token, enrollmentToken)) {
      const username = config.bootstrapAdmin.username;
      if (username === null) {
        return jsonError(c, 400, "Invite not found", "invite_not_found");
      }
      const user = getUserByUsername(db, username);
      if (!user) {
        return jsonError(c, 400, "Invite not found", "invite_not_found");
      }
      const challenge = challenges.takeRegistration(`bootstrap:${token}`);
      if (!challenge || challenge.inviteToken !== token) {
        return jsonError(
          c,
          400,
          "Registration session expired, please try again",
          "challenge_expired",
        );
      }
      if (listDiscoverableCredentialsByUser(db, user.id).length > 0) {
        return jsonError(
          c,
          400,
          "This account already has a passkey - sign in with it",
          "user_has_passkey",
        );
      }

      try {
        const data = await verifyRegistration({
          response: credential as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: config.webauthn.origin,
          expectedRPID: config.webauthn.rpId,
        });
        if (getCredentialById(db, data.id)) {
          return jsonError(
            c,
            400,
            "This passkey is already registered to another account",
            "credential_exists",
          );
        }
        createCredential(db, {
          id: data.id,
          userId: user.id,
          publicKey: data.publicKey,
          counter: data.counter,
          transports: data.transports,
          discoverable: true,
        });
        deleteLegacyCredentialsByUser(db, user.id);
        startSession(c, config, db, user.id);
        return c.json({ user: toApiUser(user) }, 200);
      } catch {
        return jsonError(c, 400, "Registration failed", "registration_failed");
      }
    }

    // (c) Generic refusal, identical to the options endpoint (SC-002).
    return jsonError(c, 400, "Invite not found", "invite_not_found");
  });

  app.post("/login/options", async (c) => {
    challenges.sweep();
    // Username-less sign-in (FR-002, R5): no request body is read. The
    // assertion options carry no allowCredentials so the authenticator only
    // surfaces its discoverable credentials (FR-010), and the challenge is
    // bound to an opaque single-use requestId.
    const options = await generateAuthenticationOptions({
      rpId: config.webauthn.rpId,
    });
    const requestId = randomUUID();
    challenges.putLogin(`login:${requestId}`, {
      challenge: options.challenge,
      requestId,
      createdAt: Date.now(),
    });
    return c.json({ requestId, options }, 200);
  });

  app.post("/login/verify", async (c) => {
    challenges.sweep();
    const body = await parseBody(c);
    if (!body.ok) return body.error;
    const requestId = body.value.requestId;
    const credential = body.value.credential;
    if (typeof requestId !== "string" || requestId === "") {
      return jsonError(
        c,
        401,
        "Authentication session expired, please try again",
        "challenge_expired",
      );
    }

    const challenge = challenges.takeLogin(`login:${requestId}`);
    if (!challenge) {
      return jsonError(
        c,
        401,
        "Authentication session expired, please try again",
        "challenge_expired",
      );
    }

    const credentialId = credentialIdOf(credential);
    if (!credentialId) {
      return jsonError(c, 401, "Missing credential", "authentication_failed");
    }

    const stored = getCredentialById(db, credentialId);
    if (!stored) {
      return jsonError(
        c,
        401,
        "No matching passkey for this account",
        "authentication_failed",
      );
    }

    // Hardening: the authenticator's userHandle must agree with the stored
    // credential's owner. @simplewebauthn/server 13 has no
    // expectedUserHandle option, so the check happens here (R6).
    const userHandle = (credential as AuthenticationResponseJSON).response
      .userHandle;
    if (
      userHandle !== undefined &&
      userHandle !== Buffer.from(stored.userId).toString("base64url")
    ) {
      return jsonError(
        c,
        401,
        "Passkey verification failed",
        "authentication_failed",
      );
    }

    try {
      const { newCounter } = await verifyLogin({
        response: credential as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.webauthn.origin,
        expectedRPID: config.webauthn.rpId,
        credential: stored,
      });
      updateCredentialCounter(
        db,
        stored.id,
        newCounter,
        new Date().toISOString(),
      );
    } catch {
      return jsonError(
        c,
        401,
        "Passkey verification failed",
        "authentication_failed",
      );
    }

    startSession(c, config, db, stored.userId);
    const user = getUserById(db, stored.userId);
    if (!user) {
      return jsonError(
        c,
        401,
        "No matching passkey for this account",
        "authentication_failed",
      );
    }
    return c.json({ user: toApiUser(user) }, 200);
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) destroySession(db, token);
    c.header(
      "Set-Cookie",
      clearSessionCookie({ secure: config.nodeEnv === "production" }),
    );
    return c.body(null, 204);
  });

  app.get("/me", (c) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) return c.json({ user: null }, 200);
    const session = validateSession(db, token, undefined, config.sessionIdleDays);
    if (!session) return c.json({ user: null }, 200);
    const user = getUserById(db, session.userId);
    return c.json({ user: user ? toApiUser(user) : null }, 200);
  });

  return app;
}
