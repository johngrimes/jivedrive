import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A named SQL migration with its contents. */
export interface Migration {
  /** File name of the migration, used as its unique version. */
  name: string;
  /** SQL to execute when the migration is applied. */
  sql: string;
}

/**
 * Open (or create) a SQLite database at the given path.
 *
 * Foreign key enforcement is enabled on the connection, which SQLite
 * disables by default.
 *
 * @param path - database file path or ":memory:"
 * @returns an open database connection
 */
export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA foreign_keys = ON;");
  // WAL lets a scan worker's write connection and this connection
  // proceed without blocking each other (the scan reconciles tens of
  // thousands of rows while the server serves reads); busy_timeout
  // turns the residual writer-writer contention into a wait instead of
  // an immediate SQLITE_BUSY.
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Apply pending migrations in order, recording each in schema_migrations.
 *
 * Each migration runs in its own transaction: a failing migration is rolled
 * back and not recorded, leaving earlier migrations applied.
 *
 * @param db - open database connection
 * @param migrations - migrations in application order
 * @returns the names of the migrations that were applied
 */
export function migrate(db: Database, migrations: Migration[]): string[] {
  db.run(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, appliedAt TEXT NOT NULL);",
  );
  const appliedRows = db
    .query("SELECT name FROM schema_migrations")
    .all() as Array<{
    name: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.name));

  const appliedNames: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const apply = db.transaction(() => {
      db.run(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (name, appliedAt) VALUES (?, ?)",
      ).run(migration.name, new Date().toISOString());
    });
    apply();
    appliedNames.push(migration.name);
  }
  return appliedNames;
}

/**
 * Load and apply all .sql files from a directory, sorted by name.
 *
 * @param db - open database connection
 * @param dirPath - directory containing migration files
 * @returns the names of the migrations that were applied
 */
export function migrateFromDir(db: Database, dirPath: string): string[] {
  const files = readdirSync(dirPath)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrations: Migration[] = files.map((name) => ({
    name,
    sql: readFileSync(join(dirPath, name), "utf8"),
  }));
  return migrate(db, migrations);
}
