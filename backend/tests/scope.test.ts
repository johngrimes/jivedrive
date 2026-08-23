import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createShare,
  createUser,
  deleteShare,
  getShareById,
} from "../src/db/repository";
import type { User } from "../src/db/repository";
import { parseSpace, resolveSpace } from "../src/scope";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/**
 * Open an in-memory database with the real schema applied.
 *
 * @returns a migrated in-memory database
 */
function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

/** Create a user with sensible defaults and return the stored row. */
function seedUser(db: Database, username: string): User {
  return createUser(db, {
    username,
    bucket: "jivedrive-prod",
    prefix: `users/${username}/`,
  });
}

describe("parseSpace", () => {
  it("maps absent and explicit own to the own space", () => {
    expect(parseSpace(undefined)).toEqual({ kind: "own" });
    expect(parseSpace("own")).toEqual({ kind: "own" });
  });

  it("maps shared:<id> to a shared space ref", () => {
    expect(parseSpace("shared:abc-123")).toEqual({
      kind: "shared",
      shareId: "abc-123",
    });
  });

  it("refuses malformed space values", () => {
    for (const bad of ["", "foo", "shared:", "shared:..", "shared:a/b"]) {
      expect(parseSpace(bad)).toBeNull();
    }
  });
});

describe("resolveSpace", () => {
  it("resolves own to the caller's bucket and prefix", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");

    const scope = resolveSpace(db, alice, { kind: "own" });

    expect(scope).toEqual({
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      mountRelative: false,
    });
  });

  it("resolves a shared space to the sharer's bucket plus prefix and folder", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    const scope = resolveSpace(db, bob, {
      kind: "shared",
      shareId: share.id,
    });

    expect(scope).toEqual({
      bucket: alice.bucket,
      prefix: "users/alice/projects/",
      mountRelative: true,
      shareId: share.id,
    });
  });

  it("resolves a nested shared folder with the folder's trailing slash", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "work/docs",
    });

    const scope = resolveSpace(db, bob, {
      kind: "shared",
      shareId: share.id,
    });

    expect(scope?.prefix).toBe("users/alice/work/docs/");
  });

  it("returns null for an unknown share id", () => {
    const db = createDb();
    const bob = seedUser(db, "bob");

    expect(
      resolveSpace(db, bob, { kind: "shared", shareId: "missing" }),
    ).toBeNull();
  });

  it("returns null when the caller is not the recipient (foreign share)", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    const carol = seedUser(db, "carol");
    // alice shared projects with bob; carol tries to use it.
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    expect(
      resolveSpace(db, carol, { kind: "shared", shareId: share.id }),
    ).toBeNull();
  });

  it("returns null for a revoked share (row deleted)", () => {
    const db = createDb();
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });

    deleteShare(db, share.id);

    expect(
      resolveSpace(db, bob, { kind: "shared", shareId: share.id }),
    ).toBeNull();
  });

  it("returns null when the share's owner row is gone (defensive)", () => {
    // Manufacture an orphaned share by deleting the owner with foreign-key
    // enforcement off, as a restore or manual edit could leave behind.
    const db = openDatabase(":memory:");
    databases.push(db);
    db.run("PRAGMA foreign_keys = OFF;");
    migrateFromDir(db, migrationsDir);
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    const share = createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });
    db.query("DELETE FROM users WHERE id = ?").run(alice.id);

    // The orphan row survives the (disabled) cascade, so resolution must
    // refuse rather than resolve against a missing owner.
    expect(getShareById(db, share.id)).not.toBeNull();
    expect(
      resolveSpace(db, bob, { kind: "shared", shareId: share.id }),
    ).toBeNull();
  });

  it("returns null for a share whose folder is the space root (defensive)", () => {
    // A row createShare would refuse, inserted behind its back (manual
    // edit): an empty folder would otherwise resolve to the whole space.
    const db = openDatabase(":memory:");
    databases.push(db);
    db.run("PRAGMA foreign_keys = OFF;");
    migrateFromDir(db, migrationsDir);
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    db.query(
      "INSERT INTO shares (id, ownerUserId, recipientUserId, folder, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).run("share-root", alice.id, bob.id, "", new Date().toISOString());

    expect(
      resolveSpace(db, bob, { kind: "shared", shareId: "share-root" }),
    ).toBeNull();
  });
});
