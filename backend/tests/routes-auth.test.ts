import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
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
  rateLimit: {
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
    username: null,
    bucket: null,
    prefix: "",
    isAdmin: true,
    enrollmentToken: null,
  },
  webauthn: { rpId, origin },
};

/** Create an app over a fresh in-memory database. */
function createAppWithDb(): { app: Hono<ServerEnv>; db: Database } {
  const db = createDb();
  const app = createApp({ config, db });
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

  it("rejects an invite whose username is already taken", async () => {
    const { app, db } = createAppWithDb();
    seedInvite(db);
    createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "invite-token-1" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "username_taken" });
  });

  it("rejects a missing token", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns registration options and the username for an existing user (T010)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: {
        rp: { id: string };
        challenge: string;
        user: { id: string; name: string };
      };
      username: string;
    };
    expect(body.options.rp.id).toBe(rpId);
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // The options carry the user's id as the userHandle (userID) bytes.
    expect(
      Buffer.from(body.options.user.id, "base64url").toString("utf8"),
    ).toBe(user.id);
    expect(body.options.user.name).toBe("admin");
    expect(body.username).toBe("admin");
    // bucket/prefix are invite-flow only (contract): omitted here.
    expect(body).not.toHaveProperty("bucket");
    expect(body).not.toHaveProperty("prefix");
  });

  it("returns 400 unknown_user for an unknown username (T010)", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unknown_user" });
  });

  it("refuses a username that already has a discoverable passkey (T011)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-discoverable",
      userId: user.id,
      publicKey: "cG9rZXk",
      discoverable: true,
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "user_has_passkey" });
  });

  it("allows a username whose only credentials are legacy (T011)", async () => {
    const { app, db } = createAppWithDb();
    createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-legacy",
      userId: getUserByUsername(db, "alice")!.id,
      publicKey: "cG9rZXk",
      transports: ["internal"],
    });

    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      options: { challenge: string };
      username: string;
    };
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.username).toBe("alice");
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

  it("refuses a first passkey for a user that already has a discoverable one", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-existing",
      userId: user.id,
      publicKey: "cG9rZXk",
      discoverable: true,
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
    expect(await res.json()).toMatchObject({ code: "user_has_passkey" });
  });

  it("stores a discoverable credential, deletes legacy credentials and signs the user in (T012)", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-legacy-1",
      userId: user.id,
      publicKey: "cG9rZXktMQ",
      transports: ["internal"],
    });
    createCredential(db, {
      id: "cred-legacy-2",
      userId: user.id,
      publicKey: "cG9rZXktMg",
      transports: ["usb"],
    });

    const optionsRes = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
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
      body: JSON.stringify({ username: "alice", credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("alice");

    // The new credential is stored as discoverable for the same user.
    const stored = getCredentialById(db, response.id);
    expect(stored?.userId).toBe(user.id);
    expect(stored?.discoverable).toBe(true);

    // The legacy credentials are gone; only the new passkey remains.
    expect(listCredentialsByUser(db, user.id).map((c) => c.id)).toEqual([
      response.id,
    ]);

    // Session cookie must be a live session.
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^jivedrive_session=/);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("alice");
  });

  it("refuses first-passkey registration for an unknown username", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "nobody",
        credential: makeRegistrationResponse({
          challenge: "c",
          origin,
          rpId,
          keyPair: makeKeyPair(),
        }),
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unknown_user" });
  });

  it("rejects a body with neither token nor username", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: {} }),
    });

    expect(res.status).toBe(400);
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
