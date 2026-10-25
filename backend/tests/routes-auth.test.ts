import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  countUsers,
  createCredential,
  createInvite,
  createUser,
  getCredentialById,
  getInviteByToken,
  getSessionByToken,
  getUserByUsername,
  listCredentialsByUser,
  markInviteClaimed,
} from "../src/db/repository";
import { createApp } from "../src/server";
import type { ServerEnv } from "../src/server";
import { createSession } from "../src/auth/sessions";
import type { AppConfig } from "../src/config";
import {
  makeAuthenticationResponse,
  makeKeyPair,
  makeRegistrationResponse,
} from "./webauthn-test-helpers";
import type { TestKeyPair } from "./webauthn-test-helpers";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

/** Open an in-memory database with the real schema applied. */
function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const rpId = "localhost";
const origin = "http://localhost:5173";

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 10485760,
  rateLimit: {
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
    authPerMinute: 20,
    authBurst: 10,
    filesPerMinute: 300,
    filesBurst: 100,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: {
    username: "admin",
    bucket: "jivedrive-prod",
    prefix: "users/admin/",
    isAdmin: true,
    enrollmentToken: "bootstrap-enrollment-token",
  },
  webauthn: { rpId, origin },
  ovh: null,
};

/** Options for {@link createAppWithDb}. */
interface CreateAppWithDbOptions {
  /** Config overrides merged over the defaults (shallow). */
  config?: Partial<AppConfig>;
  /** Injected rate-limit clock; defaults to Date.now. */
  rateLimitNow?: () => number;
}

/** Create an app over a fresh in-memory database. */
function createAppWithDb(options: CreateAppWithDbOptions = {}): {
  app: Hono<ServerEnv>;
  db: Database;
} {
  const db = createDb();
  const app = createApp({
    config: { ...config, ...options.config },
    db,
    rateLimitNow: options.rateLimitNow,
  });
  return { app, db };
}

/** Seed an admin and a pending invite for a user. */
function seedInvite(
  db: Database,
  overrides: Partial<Parameters<typeof createInvite>[1]> = {},
) {
  const admin = createUser(db, {
    username: "admin",
    bucket: "jivedrive-prod",
    prefix: "users/admin/",
    isAdmin: true,
  });
  const invite = createInvite(db, {
    token: "invite-token-1",
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
    issuedByUserId: admin.id,
    expiresAt: "2999-01-01T00:00:00.000Z",
    ...overrides,
  });
  return { admin, invite };
}

/** The session cookie value from a Set-Cookie response header. */
function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return setCookie?.split(";")[0] ?? "";
}

/**
 * Complete a username-less passkey sign-in (login/options + login/verify)
 * for a user with a registered credential.
 *
 * @param app - the app under test
 * @param user - the credential's owner (any object carrying the user id)
 * @param keyPair - the credential's keypair
 * @param credentialId - the credential id bytes
 * @param counter - assertion counter to report
 * @returns the login/verify response (carries the session cookie)
 */
async function signInWithPasskey(
  app: Hono<ServerEnv>,
  user: { id: string },
  keyPair: TestKeyPair,
  credentialId: Uint8Array,
  counter = 1,
): Promise<Response> {
  const optionsRes = await app.request("/auth/login/options", {
    method: "POST",
  });
  expect(optionsRes.status).toBe(200);
  const { requestId, options } = (await optionsRes.json()) as {
    requestId: string;
    options: { challenge: string };
  };
  return app.request("/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId,
      credential: makeAuthenticationResponse({
        challenge: options.challenge,
        origin,
        rpId,
        keyPair,
        credentialId,
        counter,
        userHandle: Buffer.from(user.id).toString("base64url"),
      }),
    }),
  });
}

describe("POST /auth/register/options", () => {
  it("returns registration options with invite details for a valid invite", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { rp: { id: string }; challenge: string };
      username: string;
      bucket: string;
      prefix: string;
    };
    expect(body.options.rp.id).toBe(rpId);
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.username).toBe("alice");
    expect(body.bucket).toBe("jivedrive-prod");
    expect(body.prefix).toBe("users/alice/");
  });

  it("rejects an unknown invite token", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "no-such-token" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invite_not_found" });
  });

  it("rejects an expired invite", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db, { expiresAt: "2000-01-01T00:00:00.000Z" });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invite_expired");
    expect(body.error).toMatch(/expired/i);
  });

  it("rejects an already-claimed invite", async () => {
    const { app, db } = createAppWithDb();
    const { invite } = seedInvite(db);
    const other = createUser(db, {
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
    });
    markInviteClaimed(db, invite.id, other.id);

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invite_claimed" });
  });

  it("returns options carrying the existing user's id for an invite whose username exists (T010)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { invite } = seedInvite(db, { username: "alice" });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { challenge: string; user: { id: string } };
      username: string;
      bucket: string;
      prefix: string;
    };
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // The passkey will ATTACH to the existing account: the options carry
    // the existing user's id as the userHandle (FR-004).
    expect(
      Buffer.from(body.options.user.id, "base64url").toString("utf8"),
    ).toBe(alice.id);
    expect(body.username).toBe("alice");
    expect(body.bucket).toBe("jivedrive-prod");
    expect(body.prefix).toBe("users/alice/");
  });

  it("allows an invite attach when the account's only credentials are legacy (T011)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-legacy",
      userId: alice.id,
      publicKey: "cG9rZXk",
      transports: ["internal"],
    });
    const { invite } = seedInvite(db, { username: "alice" });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: { user: { id: string } } };
    // Legacy-only accounts are still attachable (zero discoverable gate).
    expect(
      Buffer.from(body.options.user.id, "base64url").toString("utf8"),
    ).toBe(alice.id);
  });

  it("refuses an attach when the account already has a discoverable passkey (T012)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-discoverable",
      userId: alice.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });
    const { invite } = seedInvite(db, { username: "alice" });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "user_has_passkey" });
  });

  it("rejects a request without a token with a generic error (T007)", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/token/i);
    expect(body).not.toHaveProperty("options");
  });

  it("refuses a username-only request for an existing username (T007)", async () => {
    const { app, db } = createAppWithDb();
    createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/token/i);
    expect(body).not.toHaveProperty("options");
  });

  it("refuses a username-only request for an unknown username with the same generic error (T007)", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/token/i);
    expect(body).not.toHaveProperty("options");
  });

  it("returns options for the bootstrap admin with the correct token (T009)", async () => {
    const { app, db } = createAppWithDb();
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bootstrap-enrollment-token" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { challenge: string; user: { id: string } };
      username: string;
      bucket: string;
      prefix: string;
    };
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // The challenge is bound to the admin's OWN user id (userHandle).
    expect(
      Buffer.from(body.options.user.id, "base64url").toString("utf8"),
    ).toBe(admin.id);
    expect(body.username).toBe("admin");
    expect(body.bucket).toBe("jivedrive-prod");
    expect(body.prefix).toBe("users/admin/");
  });

  it("refuses the bootstrap token with a generic error when the admin is not provisioned (T009)", async () => {
    const { app } = createAppWithDb();

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bootstrap-enrollment-token" }),
    });

    // No admin user: the response must not reveal a bootstrap token exists.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Invite not found",
      code: "invite_not_found",
    });
  });

  it("refuses the bootstrap token after the admin has a passkey (T009)", async () => {
    const { app, db } = createAppWithDb();
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });
    createCredential(db, {
      id: "cred-admin",
      userId: admin.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bootstrap-enrollment-token" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "user_has_passkey" });
  });

  it("returns the same response shape for unknown, expired and claimed tokens (T014)", async () => {
    const { app, db } = createAppWithDb();
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });
    createInvite(db, {
      token: "invite-expired",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      issuedByUserId: admin.id,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const claimedInvite = createInvite(db, {
      token: "invite-claimed",
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    const other = createUser(db, {
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
    });
    markInviteClaimed(db, claimedInvite.id, other.id);

    for (const token of ["no-such-token", "invite-expired", "invite-claimed"]) {
      const res = await app.request("/auth/register/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; code: string };
      // Always the {error, code} shape: no options, no account-existence
      // or passkey-state disclosure (SC-002, FR-005).
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
      expect(typeof body.error).toBe("string");
      expect(typeof body.code).toBe("string");
    }
  });

  it("returns a body identical to an unknown invite for a wrong bootstrap token (T014)", async () => {
    const { app, db } = createAppWithDb();
    // The bootstrap admin exists AND is enrolled: a wrong token must still
    // produce the identical generic response (SC-002).
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });
    createCredential(db, {
      id: "cred-admin",
      userId: admin.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });

    const unknownRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "no-such-token" }),
    });
    const wrongBootstrapRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-bootstrap-token" }),
    });

    expect(unknownRes.status).toBe(400);
    expect(wrongBootstrapRes.status).toBe(400);
    expect(await wrongBootstrapRes.json()).toEqual(await unknownRes.json());
  });
});

describe("POST /auth/register/verify", () => {
  it("creates the user, claims the invite and sets the session cookie", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
      transports: ["internal"],
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1", credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string; isAdmin: boolean };
    };
    expect(body.user.username).toBe("alice");
    expect(body.user.isAdmin).toBe(false);

    // Session cookie must be set.
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^jivedrive_session=/);

    // User, credential and invite state must be persisted.
    const user = getUserByUsername(db, "alice");
    expect(user).not.toBeNull();
    expect(getCredentialById(db, response.id)?.userId).toBe(user?.id);
    const invite = getInviteByToken(db, "invite-token-1");
    expect(invite?.claimedByUserId).toBe(user?.id);
    expect(invite?.claimedAt).not.toBeNull();

    // The cookie must be a live session.
    const me = await app.request("/auth/me", {
      headers: { cookie },
    });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("alice");
  });

  it("creates the invitee with the pre-assigned id and a discoverable credential (T026)", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);

    // The registration options carry the pre-assigned user id as the
    // WebAuthn userHandle (options.user.id is the base64url of the utf8
    // id bytes): userHandle == persisted user id (R3).
    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });
    expect(optionsRes.status).toBe(200);
    const optionsBody = (await optionsRes.json()) as {
      options: { challenge: string; user: { id: string } };
      username: string;
    };
    const userIdFromOptions = Buffer.from(
      optionsBody.options.user.id,
      "base64url",
    ).toString("utf8");
    expect(userIdFromOptions).not.toBe("");

    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: optionsBody.options.challenge,
      origin,
      rpId,
      keyPair,
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1", credential: response }),
    });
    expect(res.status).toBe(200);

    // The user was created with the exact id pre-generated at options
    // time, not a fresh one (userHandle == persisted user id, R3).
    const user = getUserByUsername(db, optionsBody.username);
    expect(user).not.toBeNull();
    expect(user?.id).toBe(userIdFromOptions);

    // The credential is stored as discoverable so the invitee can later
    // sign in username-less (FR-007, SC-002).
    const stored = getCredentialById(db, response.id);
    expect(stored?.userId).toBe(user?.id);
    expect(stored?.discoverable).toBe(true);
  });

  it("refuses an expired invite at verify time", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db, { expiresAt: "2000-01-01T00:00:00.000Z" });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "invite-token-1",
        credential: makeRegistrationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invite_expired" });
  });

  it("refuses a claimed invite at verify time", async () => {
    const { app, db } = createAppWithDb();
    const { invite } = seedInvite(db);
    const other = createUser(db, {
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
    });
    markInviteClaimed(db, invite.id, other.id);

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: invite.token,
        credential: makeRegistrationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invite_claimed" });
  });

  it("fails when no registration challenge was issued (stale session)", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "invite-token-1",
        credential: makeRegistrationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "challenge_expired" });
  });

  it("fails when the registration response does not verify", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);

    await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "invite-token-1",
        credential: makeRegistrationResponse({
          challenge: "a-different-challenge",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "registration_failed" });
  });

  it("refuses a username-only verify request with no credential or session (T008)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        credential: makeRegistrationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("bad_request");
    expect(body.error).toMatch(/token/i);
    // No credential was created and no session cookie was set.
    expect(listCredentialsByUser(db, alice.id)).toHaveLength(0);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("completes the ceremony for the bootstrap admin and signs them in (T009)", async () => {
    const { app, db } = createAppWithDb();
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });
    // A legacy non-discoverable credential: re-enrollment must delete it.
    createCredential(db, {
      id: "cred-legacy",
      userId: admin.id,
      publicKey: "cG9rZXk",
      transports: ["internal"],
    });

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bootstrap-enrollment-token" }),
    });
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-enrollment-token",
        credential: response,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: {
        username: string;
        bucket: string;
        prefix: string;
        isAdmin: boolean;
      };
    };
    expect(body.user.username).toBe("admin");
    expect(body.user.bucket).toBe("jivedrive-prod");
    expect(body.user.prefix).toBe("users/admin/");
    expect(body.user.isAdmin).toBe(true);

    // The credential is stored discoverable for the admin's own account
    // and the legacy credential is cleaned up (re-enrollment semantics).
    const stored = getCredentialById(db, response.id);
    expect(stored?.userId).toBe(admin.id);
    expect(stored?.discoverable).toBe(true);
    expect(listCredentialsByUser(db, admin.id).map((cred) => cred.id)).toEqual([
      response.id,
    ]);

    // The session cookie is live: /auth/me round-trips.
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^jivedrive_session=/);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("admin");
  });

  it("attaches a passkey to an existing user with matching scope and claims the invite (T010)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-legacy",
      userId: alice.id,
      publicKey: "cG9rZXk",
      transports: ["internal"],
    });
    const { invite } = seedInvite(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const usersBefore = countUsers(db);

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as {
      options: { challenge: string; user: { id: string } };
    };
    // The ceremony was started against the EXISTING user's id.
    expect(
      Buffer.from(options.options.user.id, "base64url").toString("utf8"),
    ).toBe(alice.id);

    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token, credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("alice");

    // No new user row: the count is unchanged and the credential is owned
    // by the existing account (never a duplicate, FR-004).
    expect(countUsers(db)).toBe(usersBefore);
    const stored = getCredentialById(db, response.id);
    expect(stored?.userId).toBe(alice.id);
    expect(stored?.discoverable).toBe(true);
    // The legacy credential was cleaned up on re-enrollment.
    expect(listCredentialsByUser(db, alice.id).map((cred) => cred.id)).toEqual([
      response.id,
    ]);

    // The invite is claimed by the account it attached to.
    const claimed = getInviteByToken(db, invite.token);
    expect(claimed?.claimedByUserId).toBe(alice.id);
    expect(claimed?.claimedAt).not.toBeNull();

    // The session cookie is live.
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^jivedrive_session=/);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("alice");
  });

  it("refuses an attach when bucket, prefix or isAdmin differs (T011)", async () => {
    for (const overrides of [
      { bucket: "other-bucket" },
      { prefix: "users/other/" },
      { isAdmin: true },
    ]) {
      const { app, db } = createAppWithDb();
      const alice = createUser(db, {
        username: "alice",
        bucket: "jivedrive-prod",
        prefix: "users/alice/",
      });
      const { invite } = seedInvite(db, { username: "alice", ...overrides });

      const optionsRes = await app.request("/auth/register/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invite.token }),
      });
      expect(optionsRes.status).toBe(200);
      const options = (await optionsRes.json()) as {
        options: { challenge: string };
      };

      const res = await app.request("/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: invite.token,
          credential: makeRegistrationResponse({
            challenge: options.options.challenge,
            origin,
            rpId,
            keyPair: makeKeyPair(),
          }),
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "attach_refused" });
      // No credential was created and the account was never re-scoped or
      // re-privileged (FR-004).
      expect(listCredentialsByUser(db, alice.id)).toHaveLength(0);
      const after = getUserByUsername(db, "alice");
      expect(after?.bucket).toBe("jivedrive-prod");
      expect(after?.prefix).toBe("users/alice/");
      expect(after?.isAdmin).toBe(false);
    }
  });

  it("refuses a bootstrap challenge obtained before the admin gained a passkey (T013)", async () => {
    const { app, db } = createAppWithDb();
    const admin = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bootstrap-enrollment-token" }),
    });
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };

    // The account gains a passkey by another means before the ceremony
    // completes: the verify-time gate must refuse the stale challenge.
    createCredential(db, {
      id: "cred-elsewhere",
      userId: admin.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });

    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
      credentialId: new Uint8Array(16).fill(0x51),
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "bootstrap-enrollment-token",
        credential: response,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "user_has_passkey" });
    // The original ceremony's credential was never created.
    expect(getCredentialById(db, response.id)).toBeNull();
    expect(listCredentialsByUser(db, admin.id).map((cred) => cred.id)).toEqual([
      "cred-elsewhere",
    ]);
  });

  it("refuses an attach challenge obtained before the account gained a passkey (T013)", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { invite } = seedInvite(db, { username: "alice" });

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };

    // The account gains a passkey by another means before the ceremony
    // completes: the verify-time attach gate must refuse (FR-004).
    createCredential(db, {
      id: "cred-elsewhere",
      userId: alice.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });

    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
      credentialId: new Uint8Array(16).fill(0x52),
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invite.token, credential: response }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "attach_refused" });
    expect(getCredentialById(db, response.id)).toBeNull();
  });

  it("rejects a body without a token", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: {} }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });
});

describe("POST /auth/login/options", () => {
  it("accepts an empty body and returns requestId and bodyless assertion options (T019)", async () => {
    const { app } = createAppWithDb();

    // The username-less contract: no request body at all (FR-002, R5).
    const res = await app.request("/auth/login/options", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requestId: string;
      options: {
        challenge: string;
        allowCredentials?: unknown;
        userVerification: string;
      };
    };
    // requestId is an opaque single-use UUID (R5).
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // The username-less flow never sends allowCredentials: the
    // authenticator only surfaces discoverable credentials (FR-010).
    expect(body.options.allowCredentials).toBeUndefined();
    expect(body.options.userVerification).toBe("required");
  });

  it("returns a fresh requestId on every call (T019)", async () => {
    const { app } = createAppWithDb();

    const first = (await (
      await app.request("/auth/login/options", { method: "POST" })
    ).json()) as { requestId: string };
    const second = (await (
      await app.request("/auth/login/options", { method: "POST" })
    ).json()) as { requestId: string };

    expect(first.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe("POST /auth/login/verify", () => {
  it("creates a session for the credential's owner with no username anywhere (T020)", async () => {
    const { app, db } = createAppWithDb();
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x66);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
      transports: ["internal"],
    });

    // Username-less options: an empty body is enough (T019 contract).
    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
    });
    expect(optionsRes.status).toBe(200);
    const { requestId, options } = (await optionsRes.json()) as {
      requestId: string;
      options: { challenge: string };
    };

    const response = makeAuthenticationResponse({
      challenge: options.challenge,
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 3,
      userHandle: Buffer.from(user.id).toString("base64url"),
    });

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("alice");

    // Counter must be updated to guard against replay.
    expect(getCredentialById(db, credentialIdB64)?.counter).toBe(3);
    expect(getCredentialById(db, credentialIdB64)?.lastUsedAt).not.toBeNull();

    // Session cookie must be live: /auth/me round-trips.
    const cookie = cookieFrom(res);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("alice");
  });

  it("returns 401 challenge_expired for an unknown requestId (T020)", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "no-such-request",
        credential: makeAuthenticationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
          credentialId: new Uint8Array(16),
          counter: 1,
        }),
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "challenge_expired" });
  });

  it("returns 401 authentication_failed for an unregistered credential id (T020)", async () => {
    const { app } = createAppWithDb();

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
    });
    const { requestId, options } = (await optionsRes.json()) as {
      requestId: string;
      options: { challenge: string };
    };

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        credential: makeAuthenticationResponse({
          challenge: options.challenge,
          origin,
          rpId,
          keyPair: makeKeyPair(),
          credentialId: Buffer.from("unregistered-credential"),
          counter: 1,
          userHandle: Buffer.from("someone").toString("base64url"),
        }),
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "authentication_failed" });
  });

  it("returns 401 authentication_failed for a mismatched userHandle (T020)", async () => {
    const { app, db } = createAppWithDb();
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x6b);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
    });

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
    });
    const { requestId, options } = (await optionsRes.json()) as {
      requestId: string;
      options: { challenge: string };
    };

    // The assertion is validly signed but claims a different owner's
    // userHandle: the server must reject it before trusting the credential.
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        credential: makeAuthenticationResponse({
          challenge: options.challenge,
          origin,
          rpId,
          keyPair,
          credentialId,
          counter: 1,
          userHandle: Buffer.from("some-other-user").toString("base64url"),
        }),
      }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "authentication_failed" });
  });

  it("returns 401 for a bad signature", async () => {
    const { app, db } = createAppWithDb();
    const keyPair = makeKeyPair();
    const attackerKeyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x77);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
    });

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
    });
    const { requestId, options } = (await optionsRes.json()) as {
      requestId: string;
      options: { challenge: string };
    };
    const response = makeAuthenticationResponse({
      challenge: options.challenge,
      origin,
      rpId,
      keyPair: attackerKeyPair,
      credentialId,
      counter: 1,
      userHandle: Buffer.from(user.id).toString("base64url"),
    });

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, credential: response }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and ends the session", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x88);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
    });

    const loginRes = await signInWithPasskey(app, user, keyPair, credentialId);
    const cookie = cookieFrom(loginRes);
    const meBefore = (await (
      await app.request("/auth/me", { headers: { cookie } })
    ).json()) as { user: unknown };
    expect(meBefore.user).not.toBeNull();

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    });

    expect(logoutRes.status).toBe(204);
    const setCookie = logoutRes.headers.get("set-cookie");
    expect(setCookie).toMatch(/jivedrive_session=;/);
    expect(setCookie).toContain("Max-Age=0");

    // The session is gone server-side and /auth/me no longer sees a user.
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
  });
});

describe("GET /auth/me", () => {
  it("returns null when signed out", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it("returns the signed-in user", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x99);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
    });

    const loginRes = await signInWithPasskey(app, user, keyPair, credentialId);
    const cookie = cookieFrom(loginRes);

    const res = await app.request("/auth/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: {
        username: string;
        bucket: string;
        prefix: string;
        isAdmin: boolean;
      };
    };
    expect(body.user.username).toBe("alice");
    expect(body.user.bucket).toBe("jivedrive-prod");
    expect(body.user.prefix).toBe("users/alice/");
    expect(body.user.isAdmin).toBe(false);
  });
});

describe("session persistence across requests", () => {
  it("creates one session record per sign-in", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0xaa);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
    });

    const loginRes = await signInWithPasskey(app, user, keyPair, credentialId);
    const cookie = cookieFrom(loginRes);
    const token = cookie.split("=")[1] ?? "";
    expect(getSessionByToken(db, token)?.userId).toBe(user.id);
  });
});

describe("session idle expiry through routes (US5)", () => {
  /** Backdate a session's idle clock to 8 days ago (past the 7-day window). */
  function backdateLastUsed(db: Database, token: string): void {
    const idleCutoff = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.query("UPDATE sessions SET lastUsedAt = ? WHERE token = ?").run(
      idleCutoff,
      token,
    );
  }

  it("returns user: null and purges an idle-expired session on /auth/me (T050)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { token } = createSession(db, user.id);
    backdateLastUsed(db, token);
    const cookie = `jivedrive_session=${token}`;

    const res = await app.request("/auth/me", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
    // The lazy purge removed the idle-expired row.
    expect(getSessionByToken(db, token)).toBeNull();
  });

  it("returns 401 on a protected route for an idle-expired session (T050)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { token } = createSession(db, user.id);
    backdateLastUsed(db, token);
    const cookie = `jivedrive_session=${token}`;

    // /api/files is guarded by requireUser: the idle-expired session must
    // be refused before any S3 call.
    const res = await app.request("/api/files", { headers: { cookie } });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    expect(getSessionByToken(db, token)).toBeNull();
  });

  it("keeps a fresh session valid on /auth/me and rolls lastUsedAt forward (T050)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { token } = createSession(db, user.id);
    // Simulate a validation one hour ago — inside the window, so the
    // session is still valid.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.query("UPDATE sessions SET lastUsedAt = ? WHERE token = ?").run(
      hourAgo,
      token,
    );
    const cookie = `jivedrive_session=${token}`;

    const res = await app.request("/auth/me", { headers: { cookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("alice");
    // The rolling touch advanced the idle clock past the hour-ago value.
    const stored = getSessionByToken(db, token);
    expect(stored?.lastUsedAt).not.toBe(hourAgo);
    expect(Date.parse(stored?.lastUsedAt ?? "")).toBeGreaterThan(
      Date.parse(hourAgo),
    );
  });
});

describe("rate limiting on /auth/* (US3)", () => {
  it("returns 429 with a Retry-After header once the auth bucket is exhausted (T035)", async () => {
    const { app } = createAppWithDb();
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await app.request("/auth/login/options", { method: "POST" });
    }
    // Default limits: auth 20/min, burst 10 → the 11th request is refused.
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({
      error: "Too many requests, try again later",
      code: "rate_limited",
    });
    // Fully exhausted bucket: (1 - 0) / (20/60) = 3s, min 1.
    expect(last?.headers.get("retry-after")).toBe("3");
    // A 429 never reaches a route handler, so no cookie is ever set.
    expect(last?.headers.get("set-cookie")).toBeNull();
  });

  it("consumes no challenge state when login/verify is rate limited (T037)", async () => {
    let clock = 0;
    const { app, db } = createAppWithDb({ rateLimitNow: () => clock });
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x77);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
      transports: ["internal"],
    });

    // (1) Obtain a login challenge for the ceremony.
    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
    });
    expect(optionsRes.status).toBe(200);
    const body = (await optionsRes.json()) as {
      requestId: string;
      options: { challenge: string };
    };
    const { requestId, options } = body;

    // (2) Exhaust the auth bucket (burst 10) with rapid requests.
    let saw429 = false;
    for (let i = 0; i < 20 && !saw429; i++) {
      const res = await app.request("/auth/login/options", { method: "POST" });
      saw429 = res.status === 429;
    }
    expect(saw429).toBe(true);

    // (3) A rate-limited verify consumes no challenge and sets no cookie:
    // the middleware denies before the route handler runs.
    const makeAssertion = () =>
      makeAuthenticationResponse({
        challenge: options.challenge,
        origin,
        rpId,
        keyPair,
        credentialId,
        counter: 3,
        userHandle: Buffer.from(user.id).toString("base64url"),
      });
    const blocked = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, credential: makeAssertion() }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();

    // (4) After the refill window (20/min → full 10-token burst in 30s) the
    // challenge is still live: the same ceremony completes and lands a
    // session, proving the 429 corrupted nothing.
    clock += 30_000;
    const retry = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, credential: makeAssertion() }),
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { user: { username: string } };
    expect(retryBody.user.username).toBe("alice");
    expect(retry.headers.get("set-cookie")).not.toBeNull();
  });
});
