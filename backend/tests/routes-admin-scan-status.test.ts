/**
 * Tests for the admin scan-status surface (007-file-search follow-up):
 * the in-memory scan status registry, the scheduler/reindex recording
 * into it, and `GET /api/admin/scan-status` (per-user state, "idle"
 * before any scan, error messages surfaced). Follows the app
 * conventions of `routes-admin-reindex.test.ts` and its fake-S3
 * pattern.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createSession } from "../src/auth/sessions";
import { createUser } from "../src/db/repository";
import type { User } from "../src/db/repository";
import { createApp } from "../src/server";
import type { AppConfig } from "../src/config";
import type { Hono } from "hono";
import type { ServerEnv } from "../src/server";
import { createScanStatusRegistry } from "../src/search/status";
import type { ScanRecord } from "../src/search/status";
import type { ScanCounts } from "../src/search/indexer";
import { startScanScheduler } from "../src/search/scheduler";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config matching the reindex test's (real shape, fake credentials). */
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 10485760,
  rateLimit: {
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
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
  webauthn: { rpId: "localhost", origin: "http://localhost:5173" },
};

const bucket = "jivedrive-prod";

/** The session cookie for the seeded admin. */
const adminCookie = "jivedrive_session=admin-session";

/** The session cookie for the seeded non-admin member. */
const memberCookie = "jivedrive_session=member-session";

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/** One object in the fake S3 store. */
interface FakeObject {
  etag: string;
  size: number;
  body: string;
}

/** A fake S3 space: objects keyed by full key, iterated by the listing. */
type FakeStore = Map<string, FakeObject>;

/** One row of the scan-status response. */
interface ScanRow {
  userId: string;
  username: string;
  state: "idle" | "running" | "ok" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  counts: ScanCounts | null;
  error: string | null;
}

/** The scan-status response body. */
interface ScansResponse {
  scans: ScanRow[];
}

/**
 * Read the constructor name of an SDK command.
 *
 * @param command - the command the fake client received
 * @returns the command class name, or "" when absent
 */
function commandName(command: unknown): string {
  if (command !== null && typeof command === "object") {
    const name: unknown = (command as { constructor?: unknown }).constructor;
    if (name !== null && typeof name === "function") {
      return String(name.name);
    }
  }
  return "";
}

/**
 * Read the `Key` of an SDK GetObject command.
 *
 * @param command - the command the fake client received
 * @returns the key, or "" when absent
 */
function commandKey(command: unknown): string {
  if (command !== null && typeof command === "object" && "input" in command) {
    const input: unknown = command.input;
    if (
      input !== null &&
      typeof input === "object" &&
      "Key" in input &&
      typeof input.Key === "string"
    ) {
      return input.Key;
    }
  }
  return "";
}

/**
 * Read the `Prefix` of an SDK command without unchecked member access.
 *
 * @param command - the command the fake client received
 * @returns the prefix, or "" when absent
 */
function commandPrefix(command: unknown): string {
  if (command !== null && typeof command === "object" && "input" in command) {
    const input: unknown = command.input;
    if (
      input !== null &&
      typeof input === "object" &&
      "Prefix" in input &&
      typeof input.Prefix === "string"
    ) {
      return input.Prefix;
    }
  }
  return "";
}

/**
 * A listing function over the store: serves the keys under the
 * command's prefix; when `failWith` is set, every call throws that
 * error instead (the skewed-clock 403 stall shape).
 *
 * @param store - the fake space contents
 * @param failWith - when set, the error every listing throws
 * @returns a send-shaped function over the store
 */
function fakeSend(
  store: FakeStore,
  failWith?: Error,
): (command: unknown) => Promise<unknown> {
  return async (command: unknown) => {
    if (failWith) throw failWith;
    if (commandName(command) === "GetObjectCommand") {
      const object = store.get(commandKey(command));
      if (!object) {
        const error = new Error("NoSuchKey") as Error & { name: string };
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: object.body };
    }
    const prefix = commandPrefix(command);
    return {
      Contents: [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => {
          const object = store.get(key)!;
          return { Key: key, ETag: object.etag, Size: object.size };
        }),
      IsTruncated: false,
    };
  };
}

describe("scan status registry", () => {
  it("records running → ok with counts and timestamps", () => {
    const registry = createScanStatusRegistry();
    const run = registry.recordStart("u1");
    expect(registry.all().get("u1")?.state).toBe("running");
    registry.recordSuccess(run, { indexed: 2, reindexed: 1, removed: 3 });
    const record: ScanRecord | undefined = registry.all().get("u1");
    expect(record?.state).toBe("ok");
    expect(record?.counts).toEqual({ indexed: 2, reindexed: 1, removed: 3 });
    expect(record?.error).toBeNull();
    expect(record?.startedAt).toBe(run.startedAt.toISOString());
    expect(record?.finishedAt).not.toBeNull();
  });

  it("records failures with the error's message", () => {
    const registry = createScanStatusRegistry();
    const run = registry.recordStart("u1");
    registry.recordFailure(run, new Error("RequestTimeTooSkewed"));
    const record = registry.all().get("u1");
    expect(record?.state).toBe("error");
    expect(record?.counts).toBeNull();
    expect(record?.error).toBe("RequestTimeTooSkewed");
  });

  it("stringifies non-Error failures", () => {
    const registry = createScanStatusRegistry();
    const run = registry.recordStart("u1");
    registry.recordFailure(run, "boom");
    expect(registry.all().get("u1")?.error).toBe("boom");
  });

  it("never lets an older run's completion clobber a newer running run", () => {
    const registry = createScanStatusRegistry();
    const first = registry.recordStart("u1");
    const second = registry.recordStart("u1");
    expect(second.runId).toBeGreaterThan(first.runId);
    // The first (older) scan finishes while the second is in flight.
    registry.recordSuccess(first, { indexed: 0, reindexed: 0, removed: 0 });
    expect(registry.all().get("u1")?.state).toBe("running");
    // The newer run's completion does land.
    registry.recordFailure(second, new Error("late boom"));
    expect(registry.all().get("u1")?.state).toBe("error");
  });

  it("keeps the newer run's finished record when an older run completes late", () => {
    const registry = createScanStatusRegistry();
    const first = registry.recordStart("u1");
    const second = registry.recordStart("u1");
    // The newer run finishes first (with an error); the slow older run
    // then completes — its stale outcome must not replace the record.
    registry.recordFailure(second, new Error("S3 boom"));
    registry.recordSuccess(first, { indexed: 9, reindexed: 9, removed: 9 });
    const record = registry.all().get("u1");
    expect(record?.state).toBe("error");
    expect(record?.error).toBe("S3 boom");
    expect(record?.counts).toBeNull();
  });
});
/**
 * A stub S3 client over {@link fakeSend}.
 *
 * @param store - the fake space contents
 * @param failWith - when set, the error every command throws
 * @returns the client cast
 */
function fakeClient(store: FakeStore, failWith?: Error): S3Client {
  return {
    send: fakeSend(store, failWith),
  } as unknown as S3Client;
}

/**
 * Poll the scan-status endpoint until `predicate` holds on the user's
 * row, then return the row. Scans run in the background and expose no
 * deterministic completion signal, so polling the endpoint is the only
 * way to observe them (real-clock polling, per the reindex test's
 * waitFor precedent).
 *
 * @param app - the app under test
 * @param userId - the user whose row is awaited
 * @param predicate - the condition the row must satisfy
 * @returns the satisfying row
 */
async function waitForScan(
  app: TestApp,
  userId: string,
  predicate: (row: ScanRow) => boolean,
): Promise<ScanRow> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await app.request("/api/admin/scan-status", {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScansResponse;
    const row = body.scans.find((scan) => scan.userId === userId);
    if (row && predicate(row)) return row;
    if (Date.now() > deadline) {
      throw new Error(`scan status for ${userId} never satisfied predicate`);
    }
    await Bun.sleep(10);
  }
}

/**
 * Create an app over a fresh in-memory database with a seeded admin and
 * member (each with a session) and an explicitly shared scan status
 * registry, as production's main() wires it.
 *
 * @param client - the S3 client under the app's routes
 * @param scanStatus - the registry the admin route reads
 * @returns the app and the seeded admin and member rows
 */
function createScanStatusApp(
  client: S3Client,
  scanStatus = createScanStatusRegistry(),
): { app: TestApp; admin: User; member: User } {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const admin = createUser(db, {
    username: "admin",
    bucket,
    prefix: "users/admin/",
    isAdmin: true,
  });
  createSession(db, admin.id, { token: "admin-session" });
  const member = createUser(db, {
    username: "kate",
    bucket,
    prefix: "users/kate/",
  });
  createSession(db, member.id, { token: "member-session" });
  const app = createApp({ config, db, s3Client: client, scanStatus });
  return { app, admin, member };
}

describe("GET /api/admin/scan-status", () => {
  it("refuses non-admin callers with 403", async () => {
    const { app } = createScanStatusApp(fakeClient(new Map()));

    const res = await app.request("/api/admin/scan-status", {
      headers: { cookie: memberCookie },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  it("reports every user as idle before any scan", async () => {
    const { app, admin, member } = createScanStatusApp(fakeClient(new Map()));

    const res = await app.request("/api/admin/scan-status", {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScansResponse;

    expect(body.scans.map((scan) => scan.username).sort()).toEqual([
      "admin",
      "kate",
    ]);
    for (const scan of body.scans) {
      expect(scan.state).toBe("idle");
      expect(scan.userId === admin.id || scan.userId === member.id).toBe(true);
      expect(scan.startedAt).toBeNull();
      expect(scan.finishedAt).toBeNull();
      expect(scan.counts).toBeNull();
      expect(scan.error).toBeNull();
    }
  });

  it("reports a reindex-triggered scan as ok with counts", async () => {
    const store: FakeStore = new Map([
      ["users/kate/notes.txt", { etag: '"a"', size: 5, body: "hello" }],
    ]);
    const { app, member } = createScanStatusApp(fakeClient(store));

    const start = await app.request(`/api/admin/users/${member.id}/reindex`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(start.status).toBe(202);

    const scan = await waitForScan(app, member.id, (row) => row.state === "ok");
    expect(scan.counts).toEqual({ indexed: 1, reindexed: 0, removed: 0 });
    expect(scan.error).toBeNull();
    expect(scan.startedAt).not.toBeNull();
    expect(scan.finishedAt).not.toBeNull();
  });

  it("surfaces a failed scan's error message (the skewed-clock stall shape)", async () => {
    const failure = new Error(
      "RequestTimeTooSkewed: The difference between the request time and the current time is too large.",
    );
    const { app, member } = createScanStatusApp(fakeClient(new Map(), failure));

    const start = await app.request(`/api/admin/users/${member.id}/reindex`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(start.status).toBe(202);

    const scan = await waitForScan(
      app,
      member.id,
      (row) => row.state === "error",
    );
    expect(scan.error).toBe(failure.message);
    expect(scan.counts).toBeNull();
  });
});

describe("scan scheduler status recording", () => {
  it("records a cycle's success and failure per user into the registry", async () => {
    const store: FakeStore = new Map([
      ["users/admin/ok.txt", { etag: '"a"', size: 2, body: "hi" }],
    ]);
    const registry = createScanStatusRegistry();
    const db = openDatabase(":memory:");
    migrateFromDir(db, migrationsDir);
    databases.push(db);
    const admin = createUser(db, {
      username: "admin",
      bucket,
      prefix: "users/admin/",
      isAdmin: true,
    });
    const kate = createUser(db, {
      username: "kate",
      bucket,
      prefix: "users/kate/",
    });
    // Kate's listing fails (the skewed-clock 403 shape); admin's succeeds.
    const send = fakeSend(store);
    const client = {
      send: (command: unknown): Promise<unknown> =>
        commandPrefix(command).startsWith("users/kate/")
          ? Promise.reject(new Error("boom"))
          : send(command),
    } as unknown as S3Client;

    const handle = startScanScheduler({
      client,
      db,
      intervalSeconds: 3600,
      maxBytes: config.searchIndexMaxBytes,
      status: registry,
    });
    try {
      const deadline = Date.now() + 5000;
      while (
        (registry.all().get(admin.id)?.state !== "ok" ||
          registry.all().get(kate.id)?.state !== "error") &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(registry.all().get(admin.id)?.state).toBe("ok");
      expect(registry.all().get(admin.id)?.counts).toEqual({
        indexed: 1,
        reindexed: 0,
        removed: 0,
      });
      expect(registry.all().get(kate.id)?.state).toBe("error");
      expect(registry.all().get(kate.id)?.error).toBe("boom");
    } finally {
      handle.stop();
    }
  });
});
