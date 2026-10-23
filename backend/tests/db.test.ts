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
  createShare,
  createShareLink,
  createUser,
  deleteCredential,
  deleteCredentialsByUser,
  deleteLegacyCredentialsByUser,
  deleteInvite,
  deleteSessionById,
  deleteSessionsByUser,
  deleteShare,
  deleteShareLink,
  deleteUser,
  getCredentialById,
  getInviteByToken,
  getInviteById,
  getSearchDoc,
  getSessionByToken,
  getShareById,
  getShareLinkByToken,
  getUserById,
  getUserByUsername,
  listCredentialsByUser,
  listDiscoverableCredentialsByUser,
  listInvites,
  listSearchIndex,
  listSharesByOwner,
  listSharesByRecipient,
  listUsers,
  refreshInvite,
  markInviteClaimed,
  normalizePrefix,
  removeSearchDoc,
  searchFileNames,
  searchFolderNames,
  syncSearchFolders,
  findActiveShareLink,
  sweepExpiredShareLinks,
  updateCredentialCounter,
  updateSessionLastUsed,
  upsertSearchDoc,
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

describe("shares", () => {
  it("creates a share with generated id, timestamp and normalised folder", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    expect(share.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(share.ownerUserId).toBe(alice.id);
    expect(share.recipientUserId).toBe(bob.id);
    expect(share.folder).toBe("projects/");
    expect(new Date(share.createdAt).getTime()).not.toBeNaN();
  });

  it("normalises the folder: adds a trailing slash and collapses extras", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects//",
    });

    expect(share.folder).toBe("projects/");
  });

  it("refuses to share the space root or an empty folder", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });

    for (const folder of ["", "/", "//"]) {
      expect(() =>
        createShare(db, {
          ownerUserId: alice.id,
          recipientUserId: bob.id,
          folder,
        }),
      ).toThrow();
    }
  });

  it("refuses unsafe folders: leading slash or .. segments", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });

    for (const folder of [
      "/projects",
      "projects/../x",
      "../bob",
      "a/../../b",
    ]) {
      expect(() =>
        createShare(db, {
          ownerUserId: alice.id,
          recipientUserId: bob.id,
          folder,
        }),
      ).toThrow();
    }
  });

  it("rejects a duplicate share for the same owner, recipient and folder", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects/",
    });

    // Same folder under a different spelling still collides after normalisation.
    expect(() =>
      createShare(db, {
        ownerUserId: alice.id,
        recipientUserId: bob.id,
        folder: "projects",
      }),
    ).toThrow();

    // A different folder for the same pair is allowed.
    const other = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "docs",
    });
    expect(other.folder).toBe("docs/");
  });

  it("lists a recipient's incoming shares ordered by creation time", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const carol = seedUser(db, { username: "carol" });
    const first = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const second = createShare(db, {
      ownerUserId: carol.id,
      recipientUserId: bob.id,
      folder: "docs",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    // A share granted to someone else must not appear in bob's list.
    createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: carol.id,
      folder: "media",
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    const incoming = listSharesByRecipient(db, bob.id);
    expect(incoming.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(incoming.map((s) => s.folder)).toEqual(["projects/", "docs/"]);
  });

  it("lists an owner's outgoing shares ordered by creation time", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const carol = seedUser(db, { username: "carol" });
    const first = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const second = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: carol.id,
      folder: "docs",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    // A share owned by someone else must not appear in alice's list.
    createShare(db, {
      ownerUserId: carol.id,
      recipientUserId: alice.id,
      folder: "media",
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    const outgoing = listSharesByOwner(db, alice.id);
    expect(outgoing.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(outgoing.map((s) => s.folder)).toEqual(["projects/", "docs/"]);
  });

  it("reads a share by id and returns null when missing", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    expect(getShareById(db, share.id)?.id).toBe(share.id);
    expect(getShareById(db, share.id)?.folder).toBe("projects/");
    expect(getShareById(db, "missing")).toBeNull();
  });

  it("deletes a share", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    deleteShare(db, share.id);

    expect(getShareById(db, share.id)).toBeNull();
    expect(listSharesByOwner(db, alice.id)).toEqual([]);
    expect(listSharesByRecipient(db, bob.id)).toEqual([]);
  });

  it("cascades share deletion when either user is deleted (T003)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const carol = seedUser(db, { username: "carol" });

    // alice shares projects with bob; bob shares docs with alice; carol's
    // share with alice involves neither deleted user.
    const aliceToBob = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });
    const bobToAlice = createShare(db, {
      ownerUserId: bob.id,
      recipientUserId: alice.id,
      folder: "docs",
    });
    const carolToAlice = createShare(db, {
      ownerUserId: carol.id,
      recipientUserId: alice.id,
      folder: "media",
    });

    deleteUser(db, bob.id);

    // bob's outgoing and incoming shares are gone in both directions.
    expect(getShareById(db, aliceToBob.id)).toBeNull();
    expect(getShareById(db, bobToAlice.id)).toBeNull();
    // Shares not involving bob survive.
    expect(getShareById(db, carolToAlice.id)).not.toBeNull();
    expect(listSharesByOwner(db, alice.id)).toEqual([]);
    expect(listSharesByRecipient(db, alice.id).map((s) => s.id)).toEqual([
      carolToAlice.id,
    ]);
  });
});

describe("share links", () => {
  it("creates a link with a 12-char token and computed expiresAt (T005)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const link = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
      expiresIn: "7d",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    expect(link.token).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(link.ownerUserId).toBe(alice.id);
    expect(link.bucket).toBe("jivedrive-prod");
    expect(link.objectKey).toBe("users/alice/photos/cat.jpg");
    expect(link.expiresIn).toBe("7d");
    expect(link.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(link.expiresAt).toBe("2026-09-08T00:00:00.000Z");
  });

  it("computes expiresAt for every lifetime, 30d a full 30 days (FR-004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const cases: Array<
      [Parameters<typeof createShareLink>[1]["expiresIn"], string]
    > = [
      ["1h", "2026-09-01T01:00:00.000Z"],
      ["24h", "2026-09-02T00:00:00.000Z"],
      ["7d", "2026-09-08T00:00:00.000Z"],
      ["30d", "2026-10-01T00:00:00.000Z"],
    ];

    for (const [expiresIn, expiresAt] of cases) {
      const link = createShareLink(db, {
        ownerUserId: alice.id,
        bucket: "jivedrive-prod",
        objectKey: `users/alice/${expiresIn}.txt`,
        expiresIn,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      expect(link.expiresAt).toBe(expiresAt);
    }
  });

  it("looks a link up by token and returns null when missing", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const link = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
      expiresIn: "7d",
    });

    expect(getShareLinkByToken(db, link.token)?.objectKey).toBe(
      "users/alice/photos/cat.jpg",
    );
    expect(getShareLinkByToken(db, "no such token")).toBeNull();
  });

  it("treats an expired row as a miss", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const expired = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/old.txt",
      expiresIn: "1h",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const active = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/new.txt",
      expiresIn: "30d",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const now = new Date("2026-09-01T02:00:00.000Z");

    // Expired and unknown tokens are indistinguishable (FR-005).
    expect(getShareLinkByToken(db, expired.token, now)).toBeNull();
    expect(getShareLinkByToken(db, active.token, now)?.token).toBe(
      active.token,
    );
  });

  it("sweeps only expired rows and reports how many it deleted", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const expired = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/old.txt",
      expiresIn: "1h",
      createdAt: "2026-08-31T00:00:00.000Z",
    });
    const active = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/new.txt",
      expiresIn: "30d",
      createdAt: "2026-08-31T00:00:00.000Z",
    });
    const now = new Date("2026-09-01T00:00:00.000Z");

    expect(sweepExpiredShareLinks(db, now)).toBe(1);
    expect(getShareLinkByToken(db, expired.token, now)).toBeNull();
    expect(getShareLinkByToken(db, active.token, now)?.token).toBe(
      active.token,
    );
    // A second sweep has nothing left to delete.
    expect(sweepExpiredShareLinks(db, now)).toBe(0);
  });

  it("deletes a link by token", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const link = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
      expiresIn: "7d",
    });

    deleteShareLink(db, link.token);

    expect(getShareLinkByToken(db, link.token)).toBeNull();
  });

  it("cascades link deletion when the owner is deleted (FR-008)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const aliceLink = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/a.txt",
      expiresIn: "7d",
    });
    const bobLink = createShareLink(db, {
      ownerUserId: bob.id,
      bucket: "jivedrive-prod",
      objectKey: "users/bob/b.txt",
      expiresIn: "7d",
    });

    deleteUser(db, bob.id);

    expect(getShareLinkByToken(db, bobLink.token)).toBeNull();
    expect(getShareLinkByToken(db, aliceLink.token)?.token).toBe(
      aliceLink.token,
    );
  });

  it("retries a token collision and succeeds on a fresh draw", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const existing = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/a.txt",
      expiresIn: "7d",
    });
    let draws = 0;

    const link = createShareLink(
      db,
      {
        ownerUserId: alice.id,
        bucket: "jivedrive-prod",
        objectKey: "users/alice/b.txt",
        expiresIn: "7d",
      },
      {
        tokenFactory: () => {
          draws += 1;
          return draws === 1 ? existing.token : "freshToken12";
        },
      },
    );

    expect(draws).toBe(2);
    expect(link.token).toBe("freshToken12");
  });

  it("gives up after bounded retries when every draw collides", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const existing = createShareLink(db, {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/a.txt",
      expiresIn: "7d",
    });
    let draws = 0;

    expect(() =>
      createShareLink(
        db,
        {
          ownerUserId: alice.id,
          bucket: "jivedrive-prod",
          objectKey: "users/alice/b.txt",
          expiresIn: "7d",
        },
        {
          tokenFactory: () => {
            draws += 1;
            return existing.token;
          },
        },
      ),
    ).toThrow();
    // At least three attempts before giving up.
    expect(draws).toBeGreaterThanOrEqual(3);
  });
  it("returns the same active link for the same owner, file and lifetime (FR-006)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const key = {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
      expiresIn: "7d" as const,
    };
    const first = createShareLink(db, {
      ...key,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const second = createShareLink(db, {
      ...key,
      // Reopening the modal minutes later must not mint a new token.
      createdAt: "2026-09-04T12:00:00.000Z",
    });

    // The existing row is returned unchanged, with its remaining
    // lifetime; no duplicate record is created.
    expect(second).toEqual(first);
    const rows = db.query("SELECT COUNT(*) AS n FROM share_links").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("keeps distinct links per lifetime, both concurrently servable (FR-006)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const key = {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
    };
    const short = createShareLink(db, {
      ...key,
      expiresIn: "1h",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const long = createShareLink(db, {
      ...key,
      expiresIn: "30d",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    // A different lifetime is a different link, and both work at once.
    expect(long.token).not.toBe(short.token);
    const now = new Date("2026-09-01T00:30:00.000Z");
    expect(getShareLinkByToken(db, short.token, now)?.token).toBe(short.token);
    expect(getShareLinkByToken(db, long.token, now)?.token).toBe(long.token);
    const rows = db.query("SELECT COUNT(*) AS n FROM share_links").get() as {
      n: number;
    };
    expect(rows.n).toBe(2);
    // Returning to the earlier lifetime re-shows the first link while
    // it is still active (US3 scenario 3).
    const again = createShareLink(db, {
      ...key,
      expiresIn: "1h",
      createdAt: "2026-09-01T00:45:00.000Z",
    });
    expect(again.token).toBe(short.token);
  });

  it("mints a fresh token once the previous link expired (FR-006)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const key = {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/photos/cat.jpg",
      expiresIn: "1h" as const,
    };
    const expired = createShareLink(db, {
      ...key,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const fresh = createShareLink(db, {
      ...key,
      createdAt: "2026-09-01T02:00:00.000Z",
    });

    // Regeneration after expiry replaces the dead row: one row, new
    // token, old token no longer serves.
    expect(fresh.token).not.toBe(expired.token);
    expect(fresh.expiresAt).toBe("2026-09-01T03:00:00.000Z");
    const rows = db.query("SELECT COUNT(*) AS n FROM share_links").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    expect(
      getShareLinkByToken(
        db,
        expired.token,
        new Date("2026-09-01T02:00:00.000Z"),
      ),
    ).toBeNull();
  });
  it("finds the active link for a dedupe key and misses expired or unknown keys", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const key = {
      ownerUserId: alice.id,
      bucket: "jivedrive-prod",
      objectKey: "users/alice/a.txt",
      expiresIn: "7d" as const,
    };
    const link = createShareLink(db, {
      ...key,
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    expect(
      findActiveShareLink(db, key, new Date("2026-09-05T00:00:00.000Z")),
    ).toEqual(link);
    // The expiry boundary itself is already a miss, same rule as
    // getShareLinkByToken (FR-005).
    expect(
      findActiveShareLink(db, key, new Date("2026-09-08T00:00:00.000Z")),
    ).toBeNull();
    // A different file or lifetime is a different dedupe key (D4).
    expect(
      findActiveShareLink(db, { ...key, objectKey: "users/alice/b.txt" }),
    ).toBeNull();
    expect(findActiveShareLink(db, { ...key, expiresIn: "1h" })).toBeNull();
  });
});

describe("search index", () => {
  /** Read a raw search_docs row (rowid, fileName, body) by rowid. */
  function rawDoc(db: Database, rowid: number) {
    return db
      .query("SELECT rowid, fileName, body FROM search_docs WHERE rowid = ?")
      .get(rowid) as { rowid: number; fileName: string; body: string } | null;
  }

  it("upserts a new document into search_index and search_docs (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });

    const entry = upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/docs/notes.txt",
      etag: '"abc123"',
      size: 64,
      fileName: "notes.txt",
      body: "hello from notes",
    });

    expect(entry.userId).toBe(alice.id);
    expect(entry.key).toBe("users/alice/docs/notes.txt");
    expect(entry.etag).toBe('"abc123"');
    expect(entry.size).toBe(64);
    expect(new Date(entry.indexedAt).getTime()).not.toBeNaN();

    // The FTS row shares the search_index row's implicit rowid.
    const doc = rawDoc(db, entry.rowid);
    expect(doc).toEqual({
      rowid: entry.rowid,
      fileName: "notes.txt",
      body: "hello from notes",
    });
  });

  it("replaces both rows on re-upsert of the same key (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/report.pdf",
      etag: '"v1"',
      size: 10,
      fileName: "report.pdf",
      body: "old text",
    });

    const second = upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/report.pdf",
      etag: '"v2"',
      size: 20,
      fileName: "report.pdf",
      body: "new text",
    });

    // One bookkeeping row with the new fingerprint; the FTS table holds
    // exactly one row carrying the new text (SQLite may legitimately
    // reuse the freed rowid, so count rows rather than compare rowids).
    expect(listSearchIndex(db, alice.id)).toHaveLength(1);
    expect(second.etag).toBe('"v2"');
    expect(second.size).toBe(20);
    expect(
      db.query("SELECT COUNT(*) AS n FROM search_docs").get() as {
        n: number;
      },
    ).toEqual({ n: 1 });
    expect(rawDoc(db, second.rowid)).toEqual({
      rowid: second.rowid,
      fileName: "report.pdf",
      body: "new text",
    });
  });

  it("upserts a name-only document with an empty body (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });

    const entry = upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/big.zip",
      etag: '"big"',
      size: 99_000_000,
      fileName: "big.zip",
      body: "",
    });

    expect(entry.size).toBe(99_000_000);
    expect(rawDoc(db, entry.rowid)).toEqual({
      rowid: entry.rowid,
      fileName: "big.zip",
      body: "",
    });
  });

  it("lists index rows for a user only (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });

    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/a.txt",
      etag: '"a"',
      size: 1,
      fileName: "a.txt",
      body: "a",
    });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/b/c.txt",
      etag: '"c"',
      size: 3,
      fileName: "c.txt",
      body: "",
    });
    upsertSearchDoc(db, {
      userId: bob.id,
      key: "users/bob/b.txt",
      etag: '"b"',
      size: 2,
      fileName: "b.txt",
      body: "b",
    });

    const rows = listSearchIndex(db, alice.id);
    expect(rows.map((row) => row.key).sort()).toEqual([
      "users/alice/a.txt",
      "users/alice/b/c.txt",
    ]);
    expect(rows.every((row) => row.userId === alice.id)).toBe(true);
    expect(rows.every((row) => "indexedAt" in row)).toBe(true);
  });

  it("removes both rows by userId and key (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const entry = upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/gone.txt",
      etag: '"g"',
      size: 1,
      fileName: "gone.txt",
      body: "text",
    });

    removeSearchDoc(db, alice.id, "users/alice/gone.txt");

    expect(listSearchIndex(db, alice.id)).toEqual([]);
    expect(rawDoc(db, entry.rowid)).toBeNull();
    expect(getSearchDoc(db, alice.id, "users/alice/gone.txt")).toBeNull();
    // Removing an absent key is a no-op.
    expect(() =>
      removeSearchDoc(db, alice.id, "users/alice/absent.txt"),
    ).not.toThrow();
  });

  it("returns the doc body via getSearchDoc (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/a.txt",
      etag: '"a"',
      size: 1,
      fileName: "a.txt",
      body: "some words",
    });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/name-only.bin",
      etag: '"n"',
      size: 2,
      fileName: "name-only.bin",
      body: "",
    });

    expect(getSearchDoc(db, alice.id, "users/alice/a.txt")).toEqual({
      fileName: "a.txt",
      body: "some words",
    });
    expect(getSearchDoc(db, alice.id, "users/alice/name-only.bin")).toEqual({
      fileName: "name-only.bin",
      body: "",
    });
    expect(getSearchDoc(db, alice.id, "users/alice/absent.txt")).toBeNull();
  });

  it("deletes the user's index and FTS rows on account deletion (T004)", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    const entry = upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/a.txt",
      etag: '"a"',
      size: 1,
      fileName: "a.txt",
      body: "text",
    });
    upsertSearchDoc(db, {
      userId: bob.id,
      key: "users/bob/b.txt",
      etag: '"b"',
      size: 2,
      fileName: "b.txt",
      body: "bob text",
    });

    deleteUser(db, alice.id);

    // Cascade removed the bookkeeping row and no FTS orphan remains.
    expect(rawDoc(db, entry.rowid)).toBeNull();
    expect(
      db.query("SELECT COUNT(*) AS n FROM search_docs").get() as { n: number },
    ).toEqual({ n: 1 });
  });
});

describe("searchFileNames (T010)", () => {
  it("finds filename substring matches case-insensitively for one user only", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/projects/Q3-Report.pdf",
      etag: '"r"',
      size: 1,
      fileName: "Q3-Report.pdf",
      body: "",
    });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/notes/report ideas.txt",
      etag: '"i"',
      size: 2,
      fileName: "report ideas.txt",
      body: "",
    });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/readme.md",
      etag: '"m"',
      size: 3,
      fileName: "readme.md",
      body: "",
    });
    upsertSearchDoc(db, {
      userId: bob.id,
      key: "users/bob/report.txt",
      etag: '"b"',
      size: 4,
      fileName: "report.txt",
      body: "",
    });

    const hits = searchFileNames(db, alice.id, "report");

    expect(hits.map((hit) => hit.key).sort()).toEqual([
      "users/alice/notes/report ideas.txt",
      "users/alice/projects/Q3-Report.pdf",
    ]);
    expect(hits[0]?.fileName).toBeDefined();
  });

  it("does not match a file whose body contains the query but name does not", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/budget.xlsx",
      etag: '"x"',
      size: 5,
      fileName: "budget.xlsx",
      body: "the quarterly report numbers",
    });

    expect(searchFileNames(db, alice.id, "report")).toEqual([]);
  });

  it("honours the limit so the route can compute the capped flag", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    for (let i = 0; i < 4; i++) {
      upsertSearchDoc(db, {
        userId: alice.id,
        key: `users/alice/match-${i}.txt`,
        etag: `"${i}"`,
        size: i,
        fileName: `match-${i}.txt`,
        body: "",
      });
    }

    expect(searchFileNames(db, alice.id, "match-", 2)).toHaveLength(2);
    expect(searchFileNames(db, alice.id, "match-")).toHaveLength(4);
  });

  it("falls back to a LIKE filename query for 1-2 character queries", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/Q3-Report.pdf",
      etag: '"r"',
      size: 1,
      fileName: "Q3-Report.pdf",
      body: "",
    });
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/notes.txt",
      etag: '"n"',
      size: 2,
      fileName: "notes.txt",
      body: "",
    });

    // Trigram MATCH cannot see a 2-character query; the LIKE fallback can.
    expect(searchFileNames(db, alice.id, "q3").map((h) => h.key)).toEqual([
      "users/alice/Q3-Report.pdf",
    ]);
    expect(searchFileNames(db, alice.id, "3-").map((h) => h.key)).toEqual([
      "users/alice/Q3-Report.pdf",
    ]);
    // LIKE wildcards in the query stay literal.
    expect(searchFileNames(db, alice.id, "%")).toEqual([]);
    expect(searchFileNames(db, alice.id, "_")).toEqual([]);
  });
});

describe("search folders (folder search results, #13)", () => {
  it("finds folders by base name, case-insensitively, for one user only", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    syncSearchFolders(db, alice.id, [
      "users/alice/Projects/",
      "users/alice/archive/",
      "users/alice/archive/old-projects/",
      "users/alice/projects-docs/inner/",
    ]);
    syncSearchFolders(db, bob.id, ["users/bob/projects/"]);

    // Only the base name matches: "projects-docs/inner/" does not match
    // "proj" through its parent segment. Ordered by name, then key.
    expect(searchFolderNames(db, alice.id, "PROJ")).toEqual([
      { key: "users/alice/archive/old-projects/", name: "old-projects" },
      { key: "users/alice/Projects/", name: "Projects" },
    ]);
    expect(searchFolderNames(db, bob.id, "proj")).toEqual([
      { key: "users/bob/projects/", name: "projects" },
    ]);
  });

  it("matches 1-2 character queries and keeps LIKE wildcards literal", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    syncSearchFolders(db, alice.id, ["users/alice/Q3/", "users/alice/notes/"]);

    expect(searchFolderNames(db, alice.id, "q").map((h) => h.key)).toEqual([
      "users/alice/Q3/",
    ]);
    expect(searchFolderNames(db, alice.id, "%")).toEqual([]);
    expect(searchFolderNames(db, alice.id, "_")).toEqual([]);
  });

  it("replaces the stored set on each sync: vanished folders drop out", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    syncSearchFolders(db, alice.id, [
      "users/alice/photos/",
      "users/alice/photos2/",
    ]);

    syncSearchFolders(db, alice.id, [
      "users/alice/photos2/",
      "users/alice/photos3/",
    ]);

    expect(searchFolderNames(db, alice.id, "photos").map((h) => h.key)).toEqual(
      ["users/alice/photos2/", "users/alice/photos3/"],
    );
  });

  it("restricts hits to a key prefix, with LIKE wildcards in it literal", () => {
    const db = createDb();
    const bob = seedUser(db, { username: "bob" });
    syncSearchFolders(db, bob.id, [
      "users/bob/team_a/",
      "users/bob/team_a/plans/",
      "users/bob/teamXa/plans/",
      "users/bob/plans/",
    ]);

    // The prefix itself (the mount root) is a hit when its name matches.
    expect(
      searchFolderNames(db, bob.id, "team", 50, "users/bob/team_a/").map(
        (h) => h.key,
      ),
    ).toEqual(["users/bob/team_a/"]);
    expect(
      searchFolderNames(db, bob.id, "plans", 50, "users/bob/team_a/").map(
        (h) => h.key,
      ),
    ).toEqual(["users/bob/team_a/plans/"]);
  });

  it("honours the limit so the route can compute the capped flag", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    syncSearchFolders(
      db,
      alice.id,
      [0, 1, 2, 3].map((i) => `users/alice/match-${i}/`),
    );

    expect(searchFolderNames(db, alice.id, "match-", 2)).toHaveLength(2);
    expect(searchFolderNames(db, alice.id, "match-")).toHaveLength(4);
  });

  it("deletes the user's folder rows on account deletion", () => {
    const db = createDb();
    const alice = seedUser(db, { username: "alice" });
    const bob = seedUser(db, { username: "bob" });
    syncSearchFolders(db, alice.id, ["users/alice/docs/"]);
    syncSearchFolders(db, bob.id, ["users/bob/docs/"]);

    deleteUser(db, alice.id);

    expect(
      db.query("SELECT userId FROM search_folders").all() as Array<{
        userId: string;
      }>,
    ).toEqual([{ userId: bob.id }]);
  });
});
