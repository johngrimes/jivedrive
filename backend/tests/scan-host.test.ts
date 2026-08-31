import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import type { User } from "../src/db/repository";
import { startScanWorkerHost } from "../src/search/scan-host";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp-file database the worker can open through its own path: the
 * host hands the worker a dbPath, not a connection, so the fixture
 * must live on disk.
 */
function createFileDb(): { path: string; db: Database; user: User } {
  const dir = mkdtempSync(join(tmpdir(), "scan-host-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  databases.push(db);
  migrateFromDir(db, migrationsDir);
  const user = createUser(db, {
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
  });
  return { path: join(dir, "test.db"), db, user };
}

describe("startScanWorkerHost", () => {
  it("round-trips a scan failure back to the caller's rejected promise", async () => {
    const { path, user } = createFileDb();
    // Unreachable endpoint: the worker's listing fails and the error
    // must travel back through the worker message channel as a
    // rejection (the scheduler's failure-recording path depends on it).
    const host = startScanWorkerHost({
      dbPath: path,
      s3: {
        endpoint: "http://127.0.0.1:1",
        region: "sgp",
        accessKeyId: "test",
        secretAccessKey: "test",
      },
      cap: 1048576,
    });
    try {
      await expect(host.scan(user)).rejects.toThrow(
        /connect|ECONNREFUSED|error|fetch/i,
      );
    } finally {
      host.stop();
    }
  });

  it("stop() fails in-flight scans", async () => {
    const { path, user } = createFileDb();
    const host = startScanWorkerHost({
      dbPath: path,
      s3: {
        // Blackhole address: the connect hangs well past stop().
        endpoint: "http://10.255.255.1:9",
        region: "sgp",
        accessKeyId: "test",
        secretAccessKey: "test",
      },
      cap: 1048576,
    });
    const scanning = host.scan(user);
    host.stop();
    await expect(scanning).rejects.toThrow(/stopped|crashed/);
  });
});
