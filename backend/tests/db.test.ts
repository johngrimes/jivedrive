import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  countAdmins,
  countUsers,
  createCredential,
  createInvite,
  createSession,
  createUser,
  deleteCredential,
  deleteCredentialsByUser,
  deleteLegacyCredentialsByUser,
  deleteInvite,
  deleteSessionById,
  deleteSessionsByUser,
  deleteUser,
  getCredentialById,
  getInviteByToken,
  getInviteById,
  getSessionByToken,
  getUserById,
  getUserByUsername,
  listCredentialsByUser,
  listDiscoverableCredentialsByUser,
  listInvites,
  listUsers,
  refreshInvite,
  markInviteClaimed,
  normalizePrefix,
  updateCredentialCounter,
  updateSessionLastUsed,
} from "../src/db/repository";

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

/** Create a user with sensible defaults and return the stored row. */
function seedUser(
  db: Database,
  overrides: Partial<Parameters<typeof createUser>[1]> = {},
) {
  return createUser(db, {
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
    ...overrides,
  });
}

describe("normalizePrefix", () => {
  it("returns an empty string for empty input", () => {
    expect(normalizePrefix("")).toBe("");
    expect(normalizePrefix(undefined)).toBe("");
  });

  it("adds a trailing slash", () => {
    expect(normalizePrefix("users/alice")).toBe("users/alice/");
  });

  it("collapses trailing slashes to one", () => {
    expect(normalizePrefix("users/alice//")).toBe("users/alice/");
  });

  it("keeps an already-normalised prefix unchanged", () => {
    expect(normalizePrefix("users/alice/")).toBe("users/alice/");
  });

  it("rejects a prefix with a leading slash", () => {
    expect(() => normalizePrefix("/users/alice")).toThrow(/leading/);
  });

  it("rejects a prefix containing a .. segment (T053)", () => {
    for (const bad of ["users/../bob", "../bob", "a/../../b"]) {
      expect(() => normalizePrefix(bad)).toThrow(/\.\./);
    }
  });

  it("allows two dots inside a segment name (T053)", () => {
    expect(normalizePrefix("a..b/")).toBe("a..b/");
    expect(normalizePrefix("users/a..b")).toBe("users/a..b/");
  });
});

describe("users", () => {
  it("creates a user with generated id, timestamps and default isAdmin", () => {
    const db = createDb();
    const user = seedUser(db);

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.username).toBe("alice");
    expect(user.bucket).toBe("jivedrive-prod");
    expect(user.prefix).toBe("users/alice/");
    expect(user.isAdmin).toBe(false);
    expect(new Date(user.createdAt).getTime()).not.toBeNaN();
  });

  it("normalises a prefix without a trailing slash on create", () => {
    const db = createDb();
    const user = seedUser(db, { prefix: "users/bob" });
    expect(user.prefix).toBe("users/bob/");
  });

  it("stores an empty prefix for the bucket root", () => {
    const db = createDb();
    const user = seedUser(db, { prefix: "" });
    expect(user.prefix).toBe("");
  });

  it("stores an isAdmin flag when requested", () => {
    const db = createDb();
    const user = seedUser(db, { isAdmin: true });
    expect(user.isAdmin).toBe(true);
  });

  it("rejects an invalid username", () => {
    const db = createDb();
    for (const username of ["Alice", "a b", "a!b", "", "a".repeat(33)]) {
      expect(() => seedUser(db, { username })).toThrow(/username/);
    }
  });

  it("rejects an invalid bucket name", () => {
    const db = createDb();
    for (const bucket of ["UPPER", "ab", "a_b", "a..b", "a"]) {
      expect(() => seedUser(db, { bucket })).toThrow(/bucket/);
    }
  });

  it("rejects a prefix with a leading slash", () => {
    const db = createDb();
    expect(() => seedUser(db, { prefix: "/users/alice" })).toThrow(/leading/);
  });

  it("rejects a prefix containing a .. segment on create (T053)", () => {
    const db = createDb();
    for (const prefix of ["users/../bob", "../bob", "a/../../b"]) {
      expect(() => seedUser(db, { prefix })).toThrow(/\.\./);
    }
  });

  it("rejects a duplicate username", () => {
    const db = createDb();
    seedUser(db);
    expect(() => seedUser(db)).toThrow();
  });

  it("reads a user by id and by username", () => {
    const db = createDb();
    const user = seedUser(db);

    expect(getUserById(db, user.id)?.username).toBe("alice");
    expect(getUserByUsername(db, "alice")?.id).toBe(user.id);
    expect(getUserById(db, "missing")).toBeNull();
    expect(getUserByUsername(db, "nobody")).toBeNull();
  });

  it("lists all users", () => {
    const db = createDb();
    seedUser(db, { username: "alice" });
    seedUser(db, { username: "bob" });

    const users = listUsers(db);
    expect(users.map((u) => u.username)).toEqual(["alice", "bob"]);
  });

  it("counts users and admins", () => {
    const db = createDb();
    seedUser(db, { username: "alice" });
    seedUser(db, { username: "bob", isAdmin: true });

    expect(countUsers(db)).toBe(2);
    expect(countAdmins(db)).toBe(1);
  });

  it("deletes a user and cascades to credentials, sessions and invites", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin", isAdmin: true });
    const alice = seedUser(db, { username: "alice" });

    // alice has a credential and a session.
    createCredential(db, {
      id: "cred-alice",
      userId: alice.id,
      publicKey: "pub",
    });
    createSession(db, {
      token: "tok-alice",
      userId: alice.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    // admin issued an invite that alice claimed, plus one still pending.
    const claimed = createInvite(db, {
      token: "inv-claimed",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    markInviteClaimed(db, claimed.id, alice.id);
    const pending = createInvite(db, {
      token: "inv-pending",
      username: "carol",
      bucket: "jivedrive-prod",
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    deleteUser(db, alice.id);

    expect(getUserById(db, alice.id)).toBeNull();
    expect(getCredentialById(db, "cred-alice")).toBeNull();
    expect(getSessionByToken(db, "tok-alice")).toBeNull();
    expect(getInviteById(db, claimed.id)).toBeNull();
    expect(getInviteById(db, pending.id)).not.toBeNull();
    expect(getUserById(db, admin.id)).not.toBeNull();
  });

  it("cascades deletion to invites issued by the deleted user", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const invite = createInvite(db, {
      token: "inv-issued",
      username: "carol",
      bucket: "jivedrive-prod",
      prefix: "users/carol/",
      issuedByUserId: admin.id,
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    deleteUser(db, admin.id);

    expect(getInviteById(db, invite.id)).toBeNull();
  });
});

describe("passkey credentials", () => {
  it("creates a credential with defaults for counter, transports and lastUsedAt", () => {
    const db = createDb();
    const user = seedUser(db);
    const credential = createCredential(db, {
      id: "cred-1",
      userId: user.id,
      publicKey: "cose-public-key",
    });

    expect(credential.publicKey).toBe("cose-public-key");
    expect(credential.counter).toBe(0);
    expect(credential.transports).toEqual([]);
    expect(credential.lastUsedAt).toBeNull();
    expect(new Date(credential.createdAt).getTime()).not.toBeNaN();
  });

  it("stores transports and lastUsedAt when provided", () => {
    const db = createDb();
    const user = seedUser(db);
    const credential = createCredential(db, {
      id: "cred-2",
      userId: user.id,
      publicKey: "pub",
      transports: ["internal", "usb"],
      lastUsedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(credential.transports).toEqual(["internal", "usb"]);
    expect(credential.lastUsedAt).toBe("2026-08-12T00:00:00.000Z");
  });

  it("lists credentials for one user only", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createCredential(db, {
      id: "cred-a1",
      userId: alice.id,
      publicKey: "pub-a1",
    });
    createCredential(db, {
      id: "cred-a2",
      userId: alice.id,
      publicKey: "pub-a2",
    });
    createCredential(db, {
      id: "cred-b1",
      userId: bob.id,
      publicKey: "pub-b1",
    });

    const aliceCredentials = listCredentialsByUser(db, alice.id);
    expect(aliceCredentials.map((c) => c.id).sort()).toEqual([
      "cred-a1",
      "cred-a2",
    ]);
    expect(listCredentialsByUser(db, bob.id).map((c) => c.id)).toEqual([
      "cred-b1",
    ]);
  });

  it("reads, deletes and updates a credential", () => {
    const db = createDb();
    const user = seedUser(db);
    createCredential(db, { id: "cred-1", userId: user.id, publicKey: "pub" });

    expect(getCredentialById(db, "cred-1")?.id).toBe("cred-1");
    expect(getCredentialById(db, "nope")).toBeNull();

    updateCredentialCounter(db, "cred-1", 42, "2026-08-12T00:00:00.000Z");
    expect(getCredentialById(db, "cred-1")?.counter).toBe(42);
    expect(getCredentialById(db, "cred-1")?.lastUsedAt).toBe(
      "2026-08-12T00:00:00.000Z",
    );

    deleteCredential(db, "cred-1");
    expect(getCredentialById(db, "cred-1")).toBeNull();
  });

  it("persists the discoverable flag and returns it from reads (T005)", () => {
    const db = createDb();
    const user = seedUser(db);
    const discoverable = createCredential(db, {
      id: "cred-disc",
      userId: user.id,
      publicKey: "pub-disc",
      discoverable: true,
    });
    const legacy = createCredential(db, {
      id: "cred-legacy",
      userId: user.id,
      publicKey: "pub-legacy",
    });

    // createCredential returns the persisted flag; missing input defaults to false.
    expect(discoverable.discoverable).toBe(true);
    expect(legacy.discoverable).toBe(false);
    expect(getCredentialById(db, "cred-disc")?.discoverable).toBe(true);
    expect(getCredentialById(db, "cred-legacy")?.discoverable).toBe(false);

    const readBack = listCredentialsByUser(db, user.id);
    expect(readBack.find((c) => c.id === "cred-disc")?.discoverable).toBe(true);
    expect(readBack.find((c) => c.id === "cred-legacy")?.discoverable).toBe(
      false,
    );
  });

  it("lists only discoverable credentials for a user (T005)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createCredential(db, {
      id: "disc-1",
      userId: alice.id,
      publicKey: "p",
      discoverable: true,
    });
    createCredential(db, {
      id: "legacy-1",
      userId: alice.id,
      publicKey: "p",
    });
    createCredential(db, {
      id: "disc-2",
      userId: alice.id,
      publicKey: "p",
      discoverable: true,
    });
    createCredential(db, {
      id: "disc-bob",
      userId: bob.id,
      publicKey: "p",
      discoverable: true,
    });

    const discoverable = listDiscoverableCredentialsByUser(db, alice.id);
    expect(discoverable.map((c) => c.id).sort()).toEqual(["disc-1", "disc-2"]);
  });

  it("deletes every credential row for a user (T005)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createCredential(db, { id: "c1", userId: alice.id, publicKey: "p" });
    createCredential(db, { id: "c2", userId: alice.id, publicKey: "p" });
    createCredential(db, { id: "c3", userId: bob.id, publicKey: "p" });
    deleteCredentialsByUser(db, alice.id);

    expect(listCredentialsByUser(db, alice.id)).toEqual([]);
    expect(listCredentialsByUser(db, bob.id).map((c) => c.id)).toEqual(["c3"]);
  });

  it("deletes only legacy credentials for a user, keeping discoverable ones", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createCredential(db, {
      id: "legacy-1",
      userId: alice.id,
      publicKey: "p",
    });
    createCredential(db, {
      id: "legacy-2",
      userId: alice.id,
      publicKey: "p",
    });
    createCredential(db, {
      id: "disc-1",
      userId: alice.id,
      publicKey: "p",
      discoverable: true,
    });
    createCredential(db, {
      id: "legacy-bob",
      userId: bob.id,
      publicKey: "p",
    });

    deleteLegacyCredentialsByUser(db, alice.id);

    expect(listCredentialsByUser(db, alice.id).map((c) => c.id)).toEqual([
      "disc-1",
    ]);
    expect(listCredentialsByUser(db, bob.id).map((c) => c.id)).toEqual([
      "legacy-bob",
    ]);
  });
});

describe("invites", () => {
  it("creates an invite and finds it by token", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin", isAdmin: true });
    const invite = createInvite(db, {
      token: "invite-token-abc",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    expect(invite.username).toBe("alice");
    expect(invite.prefix).toBe("users/alice/");
    expect(invite.isAdmin).toBe(false);
    expect(invite.issuedByUserId).toBe(admin.id);
    expect(invite.expiresAt).toBe("2026-08-14T00:00:00.000Z");
    expect(invite.claimedByUserId).toBeNull();
    expect(invite.claimedAt).toBeNull();

    expect(getInviteByToken(db, "invite-token-abc")?.id).toBe(invite.id);
    expect(getInviteByToken(db, "unknown")).toBeNull();
  });

  it("stores an admin flag on the invite", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin", isAdmin: true });
    const invite = createInvite(db, {
      token: "tok-admin",
      username: "carol",
      bucket: "jivedrive-test",
      prefix: "c/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
      isAdmin: true,
    });
    expect(invite.isAdmin).toBe(true);
  });

  it("validates username, bucket and prefix", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const base = {
      token: "tok",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    };

    expect(() => createInvite(db, { ...base, username: "Bad" })).toThrow(
      /username/,
    );
    expect(() => createInvite(db, { ...base, bucket: "BAD" })).toThrow(
      /bucket/,
    );
    expect(() => createInvite(db, { ...base, prefix: "/users/alice" })).toThrow(
      /leading/,
    );
    expect(() =>
      createInvite(db, { ...base, prefix: "users/../bob/" }),
    ).toThrow(/\.\./);
  });

  it("lists invites", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const a = createInvite(db, {
      token: "tok-a",
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });
    const b = createInvite(db, {
      token: "tok-b",
      username: "bob",
      bucket: "jivedrive-test",
      prefix: "bob/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    expect(listInvites(db).map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("marks an invite as claimed", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const alice = seedUser(db, { username: "alice" });
    const invite = createInvite(db, {
      token: "tok",
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    markInviteClaimed(db, invite.id, alice.id, "2026-08-12T12:00:00.000Z");
    const claimed = getInviteById(db, invite.id);
    expect(claimed?.claimedByUserId).toBe(alice.id);
    expect(claimed?.claimedAt).toBe("2026-08-12T12:00:00.000Z");
  });

  it("deletes an invite (cancellation)", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const invite = createInvite(db, {
      token: "tok",
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    deleteInvite(db, invite.id);
    expect(getInviteById(db, invite.id)).toBeNull();
  });

  it("refreshes an invite token and expiry (admin re-send)", () => {
    const db = createDb();
    const admin = seedUser(db, { username: "admin" });
    const invite = createInvite(db, {
      token: "old-token",
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
      issuedByUserId: admin.id,
      expiresAt: "2026-08-14T00:00:00.000Z",
    });

    refreshInvite(db, invite.id, "new-token", "2026-08-16T00:00:00.000Z");

    const refreshed = getInviteById(db, invite.id);
    expect(refreshed?.token).toBe("new-token");
    expect(refreshed?.expiresAt).toBe("2026-08-16T00:00:00.000Z");
    // Everything else is untouched by a re-send.
    expect(refreshed?.username).toBe("alice");
    expect(refreshed?.issuedByUserId).toBe(admin.id);
    expect(refreshed?.claimedByUserId).toBeNull();
    // The old token no longer resolves; the new one does.
    expect(getInviteByToken(db, "old-token")).toBeNull();
    expect(getInviteByToken(db, "new-token")?.id).toBe(invite.id);
  });
});

describe("sessions", () => {
  it("creates a session and reads it by token", () => {
    const db = createDb();
    const user = seedUser(db);
    const session = createSession(db, {
      token: "opaque-token",
      userId: user.id,
      expiresAt: "2026-09-11T00:00:00.000Z",
    });

    expect(session.userId).toBe(user.id);
    expect(session.expiresAt).toBe("2026-09-11T00:00:00.000Z");
    expect(getSessionByToken(db, "opaque-token")?.id).toBe(session.id);
    expect(getSessionByToken(db, "unknown")).toBeNull();
  });

  it("deletes a session by id", () => {
    const db = createDb();
    const user = seedUser(db);
    const session = createSession(db, {
      token: "opaque-token",
      userId: user.id,
      expiresAt: "2026-09-11T00:00:00.000Z",
    });

    deleteSessionById(db, session.id);
    expect(getSessionByToken(db, "opaque-token")).toBeNull();
  });

  it("sets lastUsedAt to createdAt by default and reads it back (T003)", () => {
    const db = createDb();
    const user = seedUser(db);
    const session = createSession(db, {
      token: "opaque-token",
      userId: user.id,
      createdAt: "2026-08-05T10:00:00.000Z",
      expiresAt: "2026-09-04T10:00:00.000Z",
    });

    expect(session.lastUsedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(getSessionByToken(db, "opaque-token")?.lastUsedAt).toBe(
      "2026-08-05T10:00:00.000Z",
    );
  });

  it("honours an explicit lastUsedAt on create (T003)", () => {
    const db = createDb();
    const user = seedUser(db);
    const session = createSession(db, {
      token: "opaque-token",
      userId: user.id,
      createdAt: "2026-08-05T10:00:00.000Z",
      lastUsedAt: "2026-08-06T10:00:00.000Z",
      expiresAt: "2026-09-04T10:00:00.000Z",
    });

    expect(session.lastUsedAt).toBe("2026-08-06T10:00:00.000Z");
    expect(getSessionByToken(db, "opaque-token")?.lastUsedAt).toBe(
      "2026-08-06T10:00:00.000Z",
    );
  });

  it("updates lastUsedAt for only the given session (T003)", () => {
    const db = createDb();
    const user = seedUser(db);
    const first = createSession(db, {
      token: "tok-first",
      userId: user.id,
      createdAt: "2026-08-05T10:00:00.000Z",
      expiresAt: "2026-09-04T10:00:00.000Z",
    });
    // A second session that must keep its own lastUsedAt untouched.
    createSession(db, {
      token: "tok-second",
      userId: user.id,
      createdAt: "2026-08-05T11:00:00.000Z",
      expiresAt: "2026-09-04T11:00:00.000Z",
    });

    updateSessionLastUsed(db, first.id, "2026-08-10T12:00:00.000Z");

    expect(getSessionByToken(db, "tok-first")?.lastUsedAt).toBe(
      "2026-08-10T12:00:00.000Z",
    );
    expect(getSessionByToken(db, "tok-second")?.lastUsedAt).toBe(
      "2026-08-05T11:00:00.000Z",
    );
  });

  it("deletes every session for one user only, leaving others untouched (T003)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createSession(db, {
      token: "tok-alice-1",
      userId: alice.id,
      expiresAt: "2026-09-04T10:00:00.000Z",
    });
    createSession(db, {
      token: "tok-alice-2",
      userId: alice.id,
      expiresAt: "2026-09-04T11:00:00.000Z",
    });
    createSession(db, {
      token: "tok-bob-1",
      userId: bob.id,
      expiresAt: "2026-09-04T12:00:00.000Z",
    });

    deleteSessionsByUser(db, alice.id);

    expect(getSessionByToken(db, "tok-alice-1")).toBeNull();
    expect(getSessionByToken(db, "tok-alice-2")).toBeNull();
    expect(getSessionByToken(db, "tok-bob-1")).not.toBeNull();
  });
});
