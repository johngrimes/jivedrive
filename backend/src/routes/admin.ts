/**
 * Admin routes: user and invite management for admins only (T051, User
 * Story 6). Implemented per `contracts/openapi.yaml`.
 *
 * Every route sits behind `requireUser` plus an admin check (FR-015: a
 * non-admin gets 403). Invites expire 48 hours after creation (FR-003)
 * and removal of a user never touches storage objects (FR-014): the admin
 * routes have no S3 dependency, so no object operation can happen.
 *
 * Invite status is derived, never stored: `claimed` when the invite has
 * been claimed (claimedByUserId set), `expired` when past expiresAt and
 * never claimed, otherwise `pending` (data-model.md state transitions).
 */
import { randomBytes } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import { scanUserSpace } from "../search/indexer";
import type { ScanCounts } from "../search/indexer";
import type { ScanState, ScanStatusRegistry } from "../search/status";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import {
  cancelPendingInvitesByUsername,
  countAdmins,
  createInvite,
  deleteCredentialsByUser,
  deleteInvite,
  deleteSessionsByUser,
  deleteUser,
  getInviteById,
  getUserById,
  getUserByUsername,
  listInvites,
  listUsers,
  normalizePrefix,
  refreshInvite,
  validateBucket,
  validateUsername,
} from "../db/repository";
import type { Invite, User } from "../db/repository";

/** Invite lifetime in milliseconds: 48 hours (FR-003). */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/** Dependencies for {@link adminRoutes}. */
export interface AdminRouteDeps {
  config: AppConfig;
  db: Database;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
  /** S3 client used by the reindex endpoint's background scan (US4). */
  s3Client: S3Client;
  /** Shared scan status registry the reindex scan reports into. */
  scanStatus: ScanStatusRegistry;
}

/** One user's scan status in the admin scan-status list. */
interface AdminScanStatusResponse {
  userId: string;
  username: string;
  /** "idle" until the process has recorded a scan for the user. */
  state: ScanState | "idle";
  startedAt: string | null;
  finishedAt: string | null;
  counts: ScanCounts | null;
  error: string | null;
}

/** The user shape in the admin list: contract `User` plus createdAt. */
interface AdminUserResponse {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  /** ISO 8601 timestamp (extension beyond the contract `User` schema). */
  createdAt: string;
}

/** The invite shape returned by the API, per the contract `Invite` schema. */
interface AdminInviteResponse {
  id: string;
  username: string;
  bucket: string;
  prefix: string;
  isAdmin: boolean;
  /** ISO 8601 expiry timestamp (creation + 48 hours). */
  expiresAt: string;
  status: "pending" | "claimed" | "expired";
}

/**
 * Map a stored user to the admin list shape.
 *
 * @param user - stored user
 * @returns the admin list entry
 */
function toAdminUser(user: User): AdminUserResponse {
  return {
    id: user.id,
    username: user.username,
    bucket: user.bucket,
    prefix: user.prefix,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
  };
}

/**
 * Derive an invite's status from its claim state and expiry (data-model.md
 * state transitions: claimed wins over expired; never-claimed past expiry
 * is expired; otherwise pending).
 *
 * @param invite - stored invite
 * @param now - reference time
 * @returns the derived status
 */
function inviteStatus(
  invite: Invite,
  now: Date,
): "pending" | "claimed" | "expired" {
  if (invite.claimedByUserId !== null) return "claimed";
  if (Date.parse(invite.expiresAt) <= now.getTime()) return "expired";
  return "pending";
}

/**
 * Map a stored invite to the API shape with its derived status.
 *
 * @param invite - stored invite
 * @param now - reference time
 * @returns the API invite entry
 */
function toAdminInvite(invite: Invite, now: Date): AdminInviteResponse {
  return {
    id: invite.id,
    username: invite.username,
    bucket: invite.bucket,
    prefix: invite.prefix,
    isAdmin: invite.isAdmin,
    expiresAt: invite.expiresAt,
    status: inviteStatus(invite, now),
  };
}

/**
 * Build the full registration URL for an invite token, derived from the
 * configured WebAuthn origin (https://drive.grimes.id.au in production,
 * http://localhost:5173 in development).
 *
 * @param config - application configuration
 * @param token - invite token
 * @returns the full invite link
 */
function inviteLink(config: AppConfig, token: string): string {
  return `${config.webauthn.origin}/register?token=${token}`;
}

/**
 * Generate a fresh cryptographic invite token (256 bits, base64url).
 *
 * @returns the token
 */
function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
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
  status: 400 | 403 | 404 | 409,
  message: string,
  code: string,
): Response {
  return c.json({ error: message, code }, status);
}

/**
 * Middleware that refuses non-admin users with 403. Runs after
 * {@link AdminRouteDeps.requireUser}, which guarantees a signed-in user.
 *
 * @returns a Hono middleware handler
 */
function requireAdmin(): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    if (!c.get("user").isAdmin) {
      return c.json({ error: "Admin access required", code: "forbidden" }, 403);
    }
    await next();
  };
}

/**
 * Create the admin route module mounted under /api/admin.
 *
 * @param deps - configuration, database and auth middleware
 * @returns a Hono app with the admin routes
 */
export function adminRoutes(deps: AdminRouteDeps): Hono<ServerEnv> {
  const { config, db } = deps;

  const app = new Hono<ServerEnv>();
  app.use("*", deps.requireUser, requireAdmin());

  // List all users (FR-013). The contract `User` schema is honoured
  // exactly; createdAt is included as an extension so the users table can
  // show when the account was created (wireframes/admin-users.html).
  app.get("/users", (c) => {
    return c.json({ users: listUsers(db).map(toAdminUser) }, 200);
  });

  // Remove a user account. Only the user row is deleted; credentials,
  // sessions and invites referencing them cascade (data-model.md deletion
  // rules: sessions carry ON DELETE CASCADE, so removing a user ends their
  // sessions). No storage object is touched (FR-014). Removal is
  // idempotent: an unknown id yields 204.
  app.delete("/users", (c) => {
    const id = c.req.query("id") ?? "";
    if (id === "") {
      return jsonError(c, 400, "A user id is required", "bad_request");
    }
    const current = c.get("user");
    // Last-admin protection comes first: when the target is an admin and
    // the only one, removing them would leave no admin at all (the caller
    // must be an admin to be here, so in that case the target is the
    // caller too).
    const target = getUserById(db, id);
    if (!target) return c.body(null, 204);
    if (target.isAdmin && countAdmins(db) <= 1) {
      return jsonError(c, 400, "Cannot remove the last admin", "last_admin");
    }
    if (id === current.id) {
      return jsonError(
        c,
        400,
        "You cannot remove your own account",
        "remove_self",
      );
    }
    deleteUser(db, id);
    return c.body(null, 204);
  });

  // Reset a user's passkeys (FR-006, US2): delete every credential row,
  // revoke ALL of the user's sessions (including the caller's own when
  // resetting self), cancel pending invites for the username so exactly
  // one live invite exists, and create a fresh 48-hour re-enrollment
  // invite carrying the user's own bucket/prefix/isAdmin, issued by the
  // caller. The response returns the new invite and its registration
  // link; the user re-enrolls via the US1 attach flow (the invite's
  // username matches an existing zero-passkey account). The user row and
  // storage objects are untouched, so the admin count never changes and
  // resetting the last admin is allowed. An unknown user is refused with
  // 404 and nothing is created or deleted.
  app.delete("/users/:id/passkeys", (c) => {
    const id = c.req.param("id");
    const target = getUserById(db, id);
    if (!target) {
      return jsonError(c, 404, "User not found", "not_found");
    }
    deleteCredentialsByUser(db, id);
    deleteSessionsByUser(db, id);
    cancelPendingInvitesByUsername(db, target.username);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    const invite = createInvite(db, {
      token: newInviteToken(),
      username: target.username,
      bucket: target.bucket,
      prefix: target.prefix,
      isAdmin: target.isAdmin,
      issuedByUserId: c.get("user").id,
      expiresAt,
    });
    return c.json(
      {
        invite: toAdminInvite(invite, now),
        link: inviteLink(config, invite.token),
      },
      200,
    );
  });

  // Force an immediate search-index reconciliation of one user's space
  // (007-file-search, US4, FR-017): list the target's objects, index
  // new/changed ones (extracting text within the size cap) and remove
  // index rows for vanished objects. A full space can take far longer
  // than a client is willing to wait (a big reindex once outlived
  // Bun's 10s idle timeout and dropped the response), so the scan runs
  // in the background and the request is accepted (202) immediately;
  // the scheduler's next cycle reconciles anything this scan misses.
  // The scan reports its start, success or failure into the shared scan
  // status registry so the scan-status view shows it live.
  // An unknown user is refused with 404 and nothing is scanned.
  app.post("/users/:id/reindex", (c) => {
    const target = getUserById(db, c.req.param("id"));
    if (!target) {
      return jsonError(c, 404, "User not found", "not_found");
    }
    const run = deps.scanStatus.recordStart(target.id);
    void scanUserSpace(deps.s3Client, db, target, config.searchIndexMaxBytes)
      .then((counts) => {
        deps.scanStatus.recordSuccess(run, counts);
      })
      .catch((error: unknown) => {
        deps.scanStatus.recordFailure(run, error);
        console.error(`Search scan failed for user ${target.username}:`, error);
      });
    return c.json({ started: true }, 202);
  });

  // Per-user scan status for the admin view: the latest recorded scan
  // run per user merged with the user list, so a user never scanned
  // (or after a restart, which drops the process-lifetime records)
  // appears as "idle".
  app.get("/scan-status", (c) => {
    const records = deps.scanStatus.all();
    const scans: AdminScanStatusResponse[] = listUsers(db).map((user) => {
      const record = records.get(user.id);
      return {
        userId: user.id,
        username: user.username,
        state: record?.state ?? "idle",
        startedAt: record?.startedAt ?? null,
        finishedAt: record?.finishedAt ?? null,
        counts: record?.counts ?? null,
        error: record?.error ?? null,
      };
    });
    return c.json({ scans }, 200);
  });

  // List pending, claimed and expired invites with derived status.
  app.get("/invites", (c) => {
    const now = new Date();
    return c.json(
      { invites: listInvites(db).map((invite) => toAdminInvite(invite, now)) },
      200,
    );
  });

  // Create an invite with a 48-hour expiry (FR-003) and return the full
  // registration link. Validation reuses the Phase 2 repository helpers
  // (data-model.md); username collisions with an existing user or with a
  // still-pending invite are refused with 409 so the admin is never left
  // guessing which link will win.
  app.post("/invites", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "bad_request");
    }
    const { username, bucket, prefix, isAdmin } = (body ?? {}) as {
      username?: unknown;
      bucket?: unknown;
      prefix?: unknown;
      isAdmin?: unknown;
    };
    if (
      typeof username !== "string" ||
      typeof bucket !== "string" ||
      typeof prefix !== "string"
    ) {
      return jsonError(
        c,
        400,
        "username, bucket and prefix are required",
        "bad_request",
      );
    }
    if (isAdmin !== undefined && typeof isAdmin !== "boolean") {
      return jsonError(c, 400, "isAdmin must be a boolean", "bad_request");
    }
    try {
      validateUsername(username);
      validateBucket(bucket);
      normalizePrefix(prefix);
    } catch (error) {
      return jsonError(c, 400, (error as Error).message, "invalid_input");
    }
    if (getUserByUsername(db, username)) {
      return jsonError(
        c,
        409,
        `Username "${username}" is already taken`,
        "username_taken",
      );
    }
    const pending = listInvites(db).find(
      (invite) =>
        invite.username === username && invite.claimedByUserId === null,
    );
    if (pending) {
      return jsonError(
        c,
        409,
        `A pending or expired invite already exists for "${username}"`,
        "invite_pending",
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    const invite = createInvite(db, {
      token: newInviteToken(),
      username,
      bucket,
      prefix,
      isAdmin: isAdmin ?? false,
      issuedByUserId: c.get("user").id,
      expiresAt,
    });
    return c.json(
      {
        invite: toAdminInvite(invite, now),
        link: inviteLink(config, invite.token),
      },
      201,
    );
  });

  // Re-send an invite: a fresh token and a new 48-hour expiry for a
  // pending or expired invite (US6 scenario 3). A claimed invite is
  // refused with 404; its record is kept for the audit trail.
  app.post("/invites/:id/resend", (c) => {
    const id = c.req.param("id");
    const invite = getInviteById(db, id);
    if (!invite) {
      return jsonError(c, 404, "Invite not found", "not_found");
    }
    if (invite.claimedByUserId !== null) {
      return jsonError(
        c,
        404,
        "This invite has already been claimed",
        "invite_claimed",
      );
    }
    const token = newInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    refreshInvite(db, id, token, expiresAt);
    const refreshed = getInviteById(db, id);
    if (!refreshed) {
      return jsonError(c, 404, "Invite not found", "not_found");
    }
    return c.json(
      {
        invite: toAdminInvite(refreshed, new Date()),
        link: inviteLink(config, refreshed.token),
      },
      200,
    );
  });

  // Cancel a pending or expired invite (US6 scenarios 2-3). A claimed
  // invite is refused with 404 so its claim record survives.
  app.delete("/invites/:id", (c) => {
    const id = c.req.param("id");
    const invite = getInviteById(db, id);
    if (!invite) {
      return jsonError(c, 404, "Invite not found", "not_found");
    }
    if (invite.claimedByUserId !== null) {
      return jsonError(
        c,
        404,
        "This invite has already been claimed",
        "invite_claimed",
      );
    }
    deleteInvite(db, id);
    return c.body(null, 204);
  });

  return app;
}
