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
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: { username: null, bucket: null, prefix: "", isAdmin: true },
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

  it("registers a first passkey for an existing user with no credentials", async () => {
    const { app, db } = createAppWithDb();
    createUser(db, {
      username: "admin",
      bucket: "jivedrive-prod",
      prefix: "users/admin/",
      isAdmin: true,
    });

    // login/options for a credential-less user returns registration options.
    const loginOptionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin" }),
    });
    expect(loginOptionsRes.status).toBe(200);
    const loginBody = (await loginOptionsRes.json()) as {
      needsRegistration: boolean;
      options: { challenge: string };
    };
    expect(loginBody.needsRegistration).toBe(true);

    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: loginBody.options.challenge,
      origin,
      rpId,
      keyPair,
    });

    const res = await app.request("/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string; isAdmin: boolean };
    };
    expect(body.user.username).toBe("admin");
    expect(body.user.isAdmin).toBe(true);
    expect(getCredentialById(db, response.id)?.userId).not.toBeNull();
    expect(cookieFrom(res)).toMatch(/^jivedrive_session=/);
  });

  it("refuses a first passkey for a user that already has one", async () => {
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
  it("returns assertion options for a user with credentials", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-a1",
      userId: user.id,
      publicKey: "cG9rZXk",
      transports: ["internal"],
    });

    const res = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      needsRegistration: boolean;
      options: {
        challenge: string;
        allowCredentials: { id: string; transports: string[]; type: string }[];
      };
    };
    expect(body.needsRegistration).toBe(false);
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.options.allowCredentials).toEqual([
      { id: "cred-a1", transports: ["internal"], type: "public-key" },
    ]);
  });

  it("returns registration options with a flag for a user without credentials", async () => {
    const { app, db } = createAppWithDb();
    createUser(db, {
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
    });

    const res = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      needsRegistration: boolean;
      options: { rp: { id: string } };
    };
    expect(body.needsRegistration).toBe(true);
    expect(body.options.rp.id).toBe(rpId);
  });

  it("returns 404 for an unknown username", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unknown_user" });
  });
});

describe("POST /auth/login/verify", () => {
  it("verifies an assertion, updates the counter and sets a session cookie", async () => {
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

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const response = makeAuthenticationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 3,
    });

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", credential: response }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string } };
    expect(body.user.username).toBe("alice");

    // Counter must be updated to guard against replay.
    expect(getCredentialById(db, credentialIdB64)?.counter).toBe(3);
    expect(getCredentialById(db, credentialIdB64)?.lastUsedAt).not.toBeNull();

    // Session cookie must be live.
    const cookie = cookieFrom(res);
    const me = await app.request("/auth/me", { headers: { cookie } });
    expect(
      ((await me.json()) as { user: { username: string } }).user.username,
    ).toBe("alice");
  });

  it("returns 401 for an unknown username", async () => {
    const { app } = createAppWithDb();
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "nobody",
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
  });

  it("returns 401 when no login challenge was issued", async () => {
    const { app, db } = createAppWithDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-a1",
      userId: user.id,
      publicKey: "cG9rZXk",
    });

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
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

  it("returns 401 when the credential does not belong to the user", async () => {
    const { app, db } = createAppWithDb();
    const alice = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const bob = createUser(db, {
      username: "bob",
      bucket: "jivedrive-prod",
      prefix: "users/bob/",
    });
    createCredential(db, {
      id: "cred-alice",
      userId: alice.id,
      publicKey: "cG9rZXktYWxpY2U",
    });
    createCredential(db, {
      id: "cred-bob",
      userId: bob.id,
      publicKey: "cG9rZXktYm9i",
    });

    // alice requests a login challenge...
    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };

    // ...but asserts with bob's credential id.
    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        credential: makeAuthenticationResponse({
          challenge: options.options.challenge,
          origin,
          rpId,
          keyPair: makeKeyPair(),
          credentialId: Buffer.from("cred-bob"),
          counter: 1,
        }),
      }),
    });

    expect(res.status).toBe(401);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const response = makeAuthenticationResponse({
      challenge: options.options.challenge,
      origin,
      rpId,
      keyPair: attackerKeyPair,
      credentialId,
      counter: 1,
    });

    const res = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", credential: response }),
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

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const loginRes = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        credential: makeAuthenticationResponse({
          challenge: options.options.challenge,
          origin,
          rpId,
          keyPair,
          credentialId,
          counter: 1,
        }),
      }),
    });
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

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const loginRes = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        credential: makeAuthenticationResponse({
          challenge: options.options.challenge,
          origin,
          rpId,
          keyPair,
          credentialId,
          counter: 1,
        }),
      }),
    });
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

    const optionsRes = await app.request("/auth/login/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
    });
    const options = (await optionsRes.json()) as {
      options: { challenge: string };
    };
    const loginRes = await app.request("/auth/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        credential: makeAuthenticationResponse({
          challenge: options.options.challenge,
          origin,
          rpId,
          keyPair,
          credentialId,
          counter: 1,
        }),
      }),
    });
    const cookie = cookieFrom(loginRes);
    const token = cookie.split("=")[1] ?? "";
    expect(getSessionByToken(db, token)?.userId).toBe(user.id);
  });
});
