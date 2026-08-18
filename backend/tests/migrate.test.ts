import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, migrateFromDir, openDatabase } from "../src/db/migrate";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

/** Create an isolated in-memory database, tracked for cleanup. */
function createDb(): Database {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("openDatabase", () => {
  it("returns a working database with foreign keys enabled", () => {
    const db = createDb();
    db.run(
      "CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parentId TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);",
    );
    db.run("INSERT INTO parent (id) VALUES ('p1')");
    db.run("INSERT INTO child (id, parentId) VALUES ('c1', 'p1')");
    db.run("DELETE FROM parent WHERE id = 'p1'");

    // The cascade must have removed the child row.
    expect(db.query("SELECT COUNT(*) AS n FROM child").get()).toEqual({ n: 0 });
  });
});

describe("migrate", () => {
  it("applies migrations in filename order and records them", () => {
    const db = createDb();
    const applied = migrate(db, [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first (id TEXT PRIMARY KEY);",
      },
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second (id TEXT PRIMARY KEY);",
      },
    ]);

    expect(applied).toEqual(["001_first.sql", "002_second.sql"]);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'first'",
        )
        .get(),
    ).toBeTruthy();
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'second'",
        )
        .get(),
    ).toBeTruthy();

    const recorded = db
      .query("SELECT name FROM schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(recorded.map((r) => r.name)).toEqual([
      "001_first.sql",
      "002_second.sql",
    ]);
  });

  it("is idempotent: a second run applies nothing", () => {
    const db = createDb();
    const migrations = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first (id TEXT PRIMARY KEY);",
      },
    ];

    expect(migrate(db, migrations)).toEqual(["001_first.sql"]);
    expect(migrate(db, migrations)).toEqual([]);

    // Tables still exist and no duplicate migration rows were recorded.
    expect(
      db.query("SELECT COUNT(*) AS n FROM schema_migrations").get(),
    ).toEqual({ n: 1 });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'first'",
        )
        .get(),
    ).toBeTruthy();
  });

  it("does not re-apply migrations that are already recorded", () => {
    const db = createDb();
    const migrations = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first (id TEXT PRIMARY KEY);",
      },
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);

    // A third migration added later must be applied without touching the first two.
    const applied = migrate(db, [
      ...migrations,
      {
        name: "003_third.sql",
        sql: "CREATE TABLE third (id TEXT PRIMARY KEY);",
      },
    ]);
    expect(applied).toEqual(["003_third.sql"]);
    expect(
      db.query("SELECT name FROM schema_migrations ORDER BY name").all(),
    ).toHaveLength(3);
  });

  it("rolls back a failing migration and does not record it", () => {
    const db = createDb();
    const migrations = [
      {
        name: "001_bad.sql",
        sql: "CREATE TABLE partial (id TEXT PRIMARY KEY); INVALID SQL HERE;",
      },
    ];

    expect(() => migrate(db, migrations)).toThrow();

    // The partial table must have been rolled back and nothing recorded.
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'",
        )
        .get(),
    ).toBeFalsy();
    expect(
      db.query("SELECT COUNT(*) AS n FROM schema_migrations").get(),
    ).toEqual({ n: 0 });
  });
});

describe("migrateFromDir", () => {
  it("applies every .sql file in a directory, sorted by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "jivedrive-migrate-"));
    try {
      const sql = (name: string) =>
        `CREATE TABLE t_${name.replace(/\.sql$/, "").replace(/[^a-z0-9]/g, "_")} (id TEXT PRIMARY KEY);`;
      for (const name of ["002_b.sql", "001_a.sql", "003_c.sql"]) {
        Bun.write(join(dir, name), sql(name));
      }
      // A non-SQL file must be ignored.
      Bun.write(join(dir, "README.md"), "not a migration");

      const db = createDb();
      const applied = migrateFromDir(db, dir);
      expect(applied).toEqual(["001_a.sql", "002_b.sql", "003_c.sql"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the real initial schema from the migrations directory", () => {
    const dir = migrationsDir;
    const db = createDb();
    const applied = migrateFromDir(db, dir);

    expect(applied).toEqual([
      "001_init.sql",
      "002_passkey_discoverable.sql",
      "003_session_last_used.sql",
    ]);

    // Every table from data-model.md exists.
    for (const table of [
      "users",
      "passkey_credentials",
      "invites",
      "sessions",
      "schema_migrations",
    ]) {
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table),
      ).toBeTruthy();
    }
  });

  it("002 adds a discoverable column defaulting to 0; existing rows read as legacy", () => {
    const db = createDb();
    const initialSql = readFileSync(
      join(migrationsDir, "001_init.sql"),
      "utf8",
    );
    const secondSql = readFileSync(
      join(migrationsDir, "002_passkey_discoverable.sql"),
      "utf8",
    );

    // Apply only the initial schema first, then insert legacy data.
    expect(migrate(db, [{ name: "001_init.sql", sql: initialSql }])).toEqual([
      "001_init.sql",
    ]);
    db.run(
      "INSERT INTO users (id, username, bucket, prefix, isAdmin, createdAt) VALUES ('u1', 'alice', 'jivedrive-prod', 'users/alice/', 0, '2026-08-01T00:00:00.000Z')",
    );
    db.run(
      "INSERT INTO passkey_credentials (id, userId, publicKey, counter, transports, createdAt, lastUsedAt) VALUES ('c1', 'u1', 'pub', 0, '[]', '2026-08-01T00:00:00.000Z', NULL)",
    );

    // Applying 002 must add the discoverable column.
    expect(
      migrate(db, [{ name: "002_passkey_discoverable.sql", sql: secondSql }]),
    ).toEqual(["002_passkey_discoverable.sql"]);

    const columns = db
      .query("PRAGMA table_info(passkey_credentials)")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const discoverable = columns.find(
      (column) => column.name === "discoverable",
    );
    expect(discoverable).toBeTruthy();
    expect(discoverable?.dflt_value).toBe("0");

    // Existing rows read as legacy (0) after the migration.
    const legacy = db
      .query("SELECT discoverable FROM passkey_credentials WHERE id = 'c1'")
      .get() as { discoverable: number };
    expect(legacy.discoverable).toBe(0);

    // New rows without an explicit discoverable value default to 0.
    db.run(
      "INSERT INTO passkey_credentials (id, userId, publicKey, createdAt) VALUES ('c2', 'u1', 'pub2', '2026-08-02T00:00:00.000Z')",
    );
    const fresh = db
      .query("SELECT discoverable FROM passkey_credentials WHERE id = 'c2'")
      .get() as { discoverable: number };
    expect(fresh.discoverable).toBe(0);
  });

  it("003 adds lastUsedAt to sessions and backfills it from createdAt (T001)", () => {
    const db = createDb();
    const initialSql = readFileSync(
      join(migrationsDir, "001_init.sql"),
      "utf8",
    );
    const secondSql = readFileSync(
      join(migrationsDir, "002_passkey_discoverable.sql"),
      "utf8",
    );
    const thirdSql = readFileSync(
      join(migrationsDir, "003_session_last_used.sql"),
      "utf8",
    );

    // Apply only the first two migrations, then seed a pre-existing session
    // row as it would have been written before lastUsedAt existed.
    expect(
      migrate(db, [
        { name: "001_init.sql", sql: initialSql },
        { name: "002_passkey_discoverable.sql", sql: secondSql },
      ]),
    ).toEqual(["001_init.sql", "002_passkey_discoverable.sql"]);
    db.run(
      "INSERT INTO users (id, username, bucket, prefix, isAdmin, createdAt) VALUES ('u1', 'alice', 'jivedrive-prod', 'users/alice/', 0, '2026-08-01T00:00:00.000Z')",
    );
    db.run(
      "INSERT INTO sessions (id, token, userId, createdAt, expiresAt) VALUES ('s1', 'tok-1', 'u1', '2026-08-05T10:00:00.000Z', '2026-09-04T10:00:00.000Z')",
    );

    // Applying 003 must add the lastUsedAt column.
    expect(
      migrate(db, [{ name: "003_session_last_used.sql", sql: thirdSql }]),
    ).toEqual(["003_session_last_used.sql"]);

    const columns = db
      .query("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "lastUsedAt")).toBe(true);

    // Existing rows are backfilled from createdAt (full idle allowance).
    const seeded = db
      .query("SELECT createdAt, lastUsedAt FROM sessions WHERE id = 's1'")
      .get() as { createdAt: string; lastUsedAt: string };
    expect(seeded.lastUsedAt).toBe(seeded.createdAt);
    expect(seeded.lastUsedAt).toBe("2026-08-05T10:00:00.000Z");
  });

  it("is idempotent against the real migrations directory", () => {
    const dir = migrationsDir;
    const db = createDb();
    migrateFromDir(db, dir);
    expect(migrateFromDir(db, dir)).toEqual([]);
  });

  it("can read the initial migration file", () => {
    const sql = readFileSync(join(migrationsDir, "001_init.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE users");
  });
});
