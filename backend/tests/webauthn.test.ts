import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createCredential,
  createUser,
  getCredentialById,
  getUserByUsername,
  listCredentialsByUser,
  updateCredentialCounter,
} from "../src/db/repository";
import {
  createChallengeStore,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  toWebAuthnCredential,
  verifyLogin,
  verifyRegistration,
} from "../src/auth/webauthn";
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

describe("challenge store", () => {
  it("stores and takes a registration challenge exactly once", () => {
    const store = createChallengeStore();
    const record = {
      challenge: "challenge-1",
      username: "alice",
      inviteToken: "tok-1",
      createdAt: Date.now(),
    };

    store.putRegistration("tok-1", record);
    expect(store.takeRegistration("tok-1")).toEqual(record);
    expect(store.takeRegistration("tok-1")).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("stores and takes a login challenge exactly once", () => {
    const store = createChallengeStore();
    const record = {
      challenge: "challenge-2",
      username: "alice",
      createdAt: Date.now(),
    };

    store.putLogin("alice", record);
    expect(store.takeLogin("alice")).toEqual(record);
    expect(store.takeLogin("alice")).toBeNull();
  });

  it("returns null for an expired registration challenge", () => {
    const store = createChallengeStore(5 * 60 * 1000);
    const now = 1_000_000;
    store.putRegistration("tok-1", {
      challenge: "c",
      username: "alice",
      inviteToken: "tok-1",
      createdAt: now - 5 * 60 * 1000,
    });

    expect(store.takeRegistration("tok-1", now)).toBeNull();
  });

  it("returns null for a challenge expiring exactly at the reference time", () => {
    const store = createChallengeStore(300_000);
    const now = 1_000_000;
    store.putRegistration("tok-1", {
      challenge: "c",
      username: "alice",
      inviteToken: "tok-1",
      createdAt: now - 300_000,
    });

    expect(store.takeRegistration("tok-1", now)).toBeNull();
  });

  it("sweeps expired challenges and keeps fresh ones", () => {
    const store = createChallengeStore(300_000);
    const now = 1_000_000;
    store.putRegistration("expired", {
      challenge: "c1",
      username: "alice",
      inviteToken: "expired",
      createdAt: now - 300_001,
    });
    store.putLogin("fresh", {
      challenge: "c2",
      username: "alice",
      createdAt: now,
    });

    store.sweep(now);

    expect(store.size()).toBe(1);
    expect(store.takeLogin("fresh", now)).not.toBeNull();
  });
});

describe("registration options", () => {
  it("generates options for the relying party and username", async () => {
    const options = await generateRegistrationOptions({
      rpId,
      rpName: "JiveDrive",
      username: "alice",
    });

    expect(options.rp.id).toBe(rpId);
    expect(options.rp.name).toBe("JiveDrive");
    expect(options.user.name).toBe("alice");
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(options.pubKeyCredParams.length).toBeGreaterThan(0);
    expect(options.attestation).toBe("none");
  });

  it("excludes already-registered credentials", async () => {
    const options = await generateRegistrationOptions({
      rpId,
      rpName: "JiveDrive",
      username: "alice",
      excludeCredentials: [{ id: "cred-abc", transports: ["internal"] }],
    });

    expect(options.excludeCredentials).toEqual([
      { id: "cred-abc", transports: ["internal"], type: "public-key" },
    ]);
  });
});

describe("registration verification", () => {
  it("verifies a valid response and returns storable credential data", async () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const keyPair = makeKeyPair();
    const challenge = "challenge-for-registration";
    const response = makeRegistrationResponse({
      challenge,
      origin,
      rpId,
      keyPair,
      counter: 3,
      transports: ["internal", "usb"],
    });

    const stored = await verifyRegistration({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
    });

    expect(stored.id).toBe(response.id);
    expect(stored.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stored.counter).toBe(3);
    expect(stored.transports).toEqual(["internal", "usb"]);

    // The returned data must round-trip through the repository.
    createCredential(db, {
      id: stored.id,
      userId: user.id,
      publicKey: stored.publicKey,
      counter: stored.counter,
      transports: stored.transports,
    });
    const readBack = getCredentialById(db, stored.id);
    expect(readBack?.publicKey).toBe(stored.publicKey);
    expect(readBack?.counter).toBe(3);
    expect(readBack?.transports).toEqual(["internal", "usb"]);
    expect(listCredentialsByUser(db, user.id).map((c) => c.id)).toEqual([
      stored.id,
    ]);
  });

  it("rejects a response carrying the wrong challenge", async () => {
    const keyPair = makeKeyPair();
    const response = makeRegistrationResponse({
      challenge: "wrong-challenge",
      origin,
      rpId,
      keyPair,
    });

    await expect(
      verifyRegistration({
        response,
        expectedChallenge: "expected-challenge",
        expectedOrigin: origin,
        expectedRPID: rpId,
      }),
    ).rejects.toThrow(/challenge/);
  });

  it("rejects a response from the wrong origin", async () => {
    const keyPair = makeKeyPair();
    const challenge = "challenge";
    const response = makeRegistrationResponse({
      challenge,
      origin: "https://evil.example",
      rpId,
      keyPair,
    });

    await expect(
      verifyRegistration({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      }),
    ).rejects.toThrow(/origin/);
  });

  it("rejects a response for the wrong relying party", async () => {
    const keyPair = makeKeyPair();
    const challenge = "challenge";
    const response = makeRegistrationResponse({
      challenge,
      origin,
      rpId: "evil.example",
      keyPair,
    });

    await expect(
      verifyRegistration({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      }),
    ).rejects.toThrow(/RP ID/);
  });
});

describe("login options", () => {
  it("includes the user's stored credentials in allowCredentials", async () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-a1",
      userId: user.id,
      publicKey: "cG9rZXk",
      transports: ["internal", "usb"],
    });
    createCredential(db, {
      id: "cred-a2",
      userId: user.id,
      publicKey: "cG9rZXky",
    });

    const credentials = listCredentialsByUser(db, user.id).map((c) => ({
      id: c.id,
      transports: c.transports,
    }));
    const options = await generateAuthenticationOptions({
      rpId,
      allowCredentials: credentials,
    });

    expect(options.rpId).toBe(rpId);
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(options.allowCredentials).toEqual([
      { id: "cred-a1", transports: ["internal", "usb"], type: "public-key" },
      { id: "cred-a2", transports: [], type: "public-key" },
    ]);
  });

  it("produces an empty allowCredentials list without stored credentials", async () => {
    const options = await generateAuthenticationOptions({
      rpId,
      allowCredentials: [],
    });
    expect(options.allowCredentials).toEqual([]);
  });
});

describe("login verification", () => {
  it("verifies a valid assertion and reports the new counter", async () => {
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x11);
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: Buffer.from(credentialId).toString("base64url"),
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
      transports: ["internal"],
    });
    const stored = getCredentialById(
      db,
      Buffer.from(credentialId).toString("base64url"),
    );
    expect(stored).not.toBeNull();

    const challenge = "challenge-for-login";
    const response = makeAuthenticationResponse({
      challenge,
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 5,
    });

    const result = await verifyLogin({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: stored as NonNullable<typeof stored>,
    });

    expect(result.newCounter).toBe(5);
  });

  it("updates the stored counter after a successful assertion", async () => {
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x22);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const db = createDb();
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

    const challenge = "challenge-for-login";
    const response = makeAuthenticationResponse({
      challenge,
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 4,
    });
    const result = await verifyLogin({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: getCredentialById(db, credentialIdB64) as NonNullable<
        ReturnType<typeof getCredentialById>
      >,
    });

    updateCredentialCounter(db, credentialIdB64, result.newCounter);
    expect(getCredentialById(db, credentialIdB64)?.counter).toBe(4);
  });

  it("rejects a replayed assertion with a stale counter", async () => {
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x33);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    // The stored counter is already 5, so a response claiming counter 5 is a
    // replay.
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 5,
    });

    const challenge = "challenge-for-login";
    const response = makeAuthenticationResponse({
      challenge,
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 5,
    });

    await expect(
      verifyLogin({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: getCredentialById(db, credentialIdB64) as NonNullable<
          ReturnType<typeof getCredentialById>
        >,
      }),
    ).rejects.toThrow(/counter/);
  });

  it("rejects an assertion signed by a different key", async () => {
    const storedKeyPair = makeKeyPair();
    const attackerKeyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x44);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(storedKeyPair.cosePublicKey).toString("base64url"),
      counter: 0,
    });

    const challenge = "challenge-for-login";
    const response = makeAuthenticationResponse({
      challenge,
      origin,
      rpId,
      keyPair: attackerKeyPair,
      credentialId,
      counter: 1,
    });

    await expect(
      verifyLogin({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: getCredentialById(db, credentialIdB64) as NonNullable<
          ReturnType<typeof getCredentialById>
        >,
      }),
    ).rejects.toThrow();
  });

  it("rejects an assertion for the wrong challenge", async () => {
    const keyPair = makeKeyPair();
    const credentialId = new Uint8Array(16).fill(0x55);
    const credentialIdB64 = Buffer.from(credentialId).toString("base64url");
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: credentialIdB64,
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
    });

    const response = makeAuthenticationResponse({
      challenge: "wrong-challenge",
      origin,
      rpId,
      keyPair,
      credentialId,
      counter: 1,
    });

    await expect(
      verifyLogin({
        response,
        expectedChallenge: "expected-challenge",
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential: getCredentialById(db, credentialIdB64) as NonNullable<
          ReturnType<typeof getCredentialById>
        >,
      }),
    ).rejects.toThrow(/challenge/);
  });
});

describe("credential conversion", () => {
  it("converts a stored credential back into a WebAuthnCredential", async () => {
    const keyPair = makeKeyPair();
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-1",
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 7,
      transports: ["internal"],
    });
    const stored = getCredentialById(db, "cred-1");
    expect(stored).not.toBeNull();

    const converted = toWebAuthnCredential(
      stored as NonNullable<typeof stored>,
    );

    expect(converted.id).toBe("cred-1");
    expect(converted.counter).toBe(7);
    expect(converted.transports).toEqual(["internal"]);
    expect(converted.publicKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(converted.publicKey)).toEqual(
      Array.from(keyPair.cosePublicKey),
    );
  });

  it("is used by the login flow to find a user's credentials", async () => {
    const db = createDb();
    const keyPair = makeKeyPair();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    createCredential(db, {
      id: "cred-1",
      userId: user.id,
      publicKey: Buffer.from(keyPair.cosePublicKey).toString("base64url"),
      counter: 0,
      transports: ["internal"],
    });

    const found = getUserByUsername(db, "alice");
    expect(found).not.toBeNull();
    const credentials = listCredentialsByUser(
      db,
      (found as NonNullable<typeof found>).id,
    );
    expect(credentials.length).toBe(1);
    expect(
      toWebAuthnCredential(
        credentials[0] as NonNullable<(typeof credentials)[0]>,
      ).id,
    ).toBe("cred-1");
  });
});
