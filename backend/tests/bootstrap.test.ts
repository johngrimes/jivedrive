import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { countUsers, getUserByUsername } from "../src/db/repository";
import { bootstrapAdmin } from "../src/db/bootstrap";
import type { BootstrapAdminConfig } from "../src/config";

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

/** A fully configured bootstrap admin. */
function adminConfig(
  overrides: Partial<BootstrapAdminConfig> = {},
): BootstrapAdminConfig {
  return {
    username: "admin",
    bucket: "jivedrive-prod",
    prefix: "users/admin/",
    isAdmin: true,
    enrollmentToken: null,
    ...overrides,
  };
}

describe("bootstrapAdmin", () => {
  it("does nothing when no bootstrap admin is configured", () => {
    const db = createDb();
    const result = bootstrapAdmin(db, {
      username: null,
      bucket: null,
      prefix: "",
      isAdmin: true,
      enrollmentToken: null,
    });

    expect(result).toBeNull();
    expect(countUsers(db)).toBe(0);
  });

  it("provisions the admin with the configured bucket and prefix", () => {
    const db = createDb();
    const admin = bootstrapAdmin(db, adminConfig({ prefix: "users/admin" }));

    expect(admin).not.toBeNull();
    expect(admin?.username).toBe("admin");
    expect(admin?.bucket).toBe("jivedrive-prod");
    // Prefix is normalised to end with a slash.
    expect(admin?.prefix).toBe("users/admin/");
    expect(admin?.isAdmin).toBe(true);
    expect(getUserByUsername(db, "admin")?.id).toBe(admin?.id);
  });

  it("creates the bootstrap account as an admin by default", () => {
    const db = createDb();
    const admin = bootstrapAdmin(db, adminConfig());

    expect(admin?.isAdmin).toBe(true);
    expect(getUserByUsername(db, "admin")?.isAdmin).toBe(true);
  });

  it("honours an explicit non-admin flag when configured", () => {
    const db = createDb();
    const admin = bootstrapAdmin(db, adminConfig({ isAdmin: false }));

    expect(admin?.isAdmin).toBe(false);
  });

  it("does not duplicate an existing username", () => {
    const db = createDb();
    bootstrapAdmin(db, adminConfig());

    // A second startup must not create a second user or throw.
    const second = bootstrapAdmin(db, adminConfig());

    expect(second).toBeNull();
    expect(countUsers(db)).toBe(1);
  });

  it("does not overwrite an existing user with the same username", () => {
    const db = createDb();
    bootstrapAdmin(db, adminConfig());

    const existing = getUserByUsername(db, "admin");
    expect(existing?.createdAt).toBeTruthy();

    const after = getUserByUsername(db, "admin");
    expect(after?.bucket).toBe("jivedrive-prod");
    expect(after?.isAdmin).toBe(true);
  });

  it("allows an empty prefix for the bucket root", () => {
    const db = createDb();
    const admin = bootstrapAdmin(db, adminConfig({ prefix: "" }));

    expect(admin?.prefix).toBe("");
  });
});
