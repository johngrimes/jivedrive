/**
 * Route tests for `POST /api/admin/users/:id/reindex` (007-file-search,
 * US4, T024): force a search-index reconciliation of one user's space;
 * the scan runs in the background and the route accepts immediately.
 * Follows the app conventions of `routes-admin.test.ts` and the
 * fake-S3 pattern of `search-indexer.test.ts`: the fake client
 * serves listings and downloads from an in-memory store so the route's
 * scan exercises the real indexer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createSession } from "../src/auth/sessions";
import {
  createUser,
  getSearchDoc,
  upsertSearchDoc,
} from "../src/db/repository";
import type { User } from "../src/db/repository";
import { createApp } from "../src/server";
import type { AppConfig } from "../src/config";
import type { Hono } from "hono";
import type { ServerEnv } from "../src/server";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config whose reindex cap comfortably fits the fake objects. */
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

/**
 * Poll until `predicate` holds or a deadline passes, then assert it:
 * the reindex scan runs in the background, so its effects are only
 * eventually visible.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(predicate()).toBe(true);
}

/**
 * A stub S3 client (search-indexer.test.ts pattern): routes by command
 * constructor name and serves listings/downloads from the store.
 *
 * @param store - the fake space contents
 * @returns the client cast and the recorded command names
 */
function fakeClient(store: FakeStore): {
  client: S3Client;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor
        .name;
      calls.push(name);
      const input = (command as { input: Record<string, unknown> }).input ?? {};
      switch (name) {
        case "ListObjectsV2Command": {
          const prefix = (input.Prefix as string) ?? "";
          const keys = [...store.keys()]
            .filter((k) => k.startsWith(prefix))
            .sort();
          return {
            Contents: keys.map((key) => {
              const object = store.get(key)!;
              return { Key: key, ETag: object.etag, Size: object.size };
            }),
            IsTruncated: false,
          };
        }
        case "GetObjectCommand": {
          const object = store.get(input.Key as string);
          if (!object) {
            const err = new Error("NoSuchKey") as Error & { name: string };
            err.name = "NoSuchKey";
            throw err;
          }
          return { Body: object.body };
        }
        default:
          throw new Error(`Unexpected command: ${name}`);
      }
    },
  } as unknown as S3Client;
  return { client, calls };
}

/**
 * Create an app over a fresh in-memory database with a seeded admin and
 * member (each with a session) and a fake S3 client serving their spaces.
 *
 * @param store - the fake space contents
 * @returns the app, db, the seeded admin and member rows and the
 *   recorded S3 command names
 */
function createReindexApp(store: FakeStore): {
  app: TestApp;
  db: Database;
  admin: User;
  member: User;
  calls: string[];
} {
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
  const { client, calls } = fakeClient(store);
  const app = createApp({ config, db, s3Client: client });
  return { app, db, admin, member, calls };
}

/** Seed one indexed object row for a user. */
function seedDoc(
  db: Database,
  userId: string,
  key: string,
  etag: string,
  body = "",
): void {
  upsertSearchDoc(db, {
    userId,
    key,
    etag,
    size: new TextEncoder().encode(body).length,
    fileName: key.slice(key.lastIndexOf("/") + 1),
    body,
  });
}

/** Issue a reindex request for a user as the admin. */
async function reindex(app: TestApp, id: string): Promise<Response> {
  return app.request(`/api/admin/users/${id}/reindex`, {
    method: "POST",
    headers: { cookie: adminCookie },
  });
}

describe("POST /api/admin/users/:id/reindex (US4)", () => {
  it("refuses non-admin callers with 403 and never touches S3 (T024)", async () => {
    const store: FakeStore = new Map();
    const { app, calls } = createReindexApp(store);

    const res = await app.request("/api/admin/users/whatever/reindex", {
      method: "POST",
      headers: { cookie: memberCookie },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
    expect(calls).toEqual([]);
  });

  it("returns 404 with code not_found for an unknown user (T024)", async () => {
    const store: FakeStore = new Map();
    const { app, calls } = createReindexApp(store);

    const res = await reindex(app, "no-such-user");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("accepts the request (202) and the background scan reconciles the space (T024)", async () => {
    // Kate's space: one unchanged object, one changed object (new etag),
    // one new object carrying a unique phrase, and one index row whose
    // storage object has vanished.
    const store: FakeStore = new Map([
      ["users/kate/kept.txt", { etag: '"same"', size: 10, body: "stale text" }],
      ["users/kate/changed.txt", { etag: '"v2"', size: 5, body: "fresh" }],
      [
        "users/kate/new report.txt",
        {
          etag: '"new"',
          size: 9,
          body: "the quokka brigade rides at dawn",
        },
      ],
    ]);
    const { app, db, member, calls } = createReindexApp(store);
    seedDoc(db, member.id, "users/kate/kept.txt", '"same"', "stale text");
    seedDoc(db, member.id, "users/kate/changed.txt", '"v1"', "old text");
    seedDoc(db, member.id, "users/kate/gone.txt", '"gone"');

    const res = await reindex(app, member.id);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true });

    // The scan runs in the background: wait for it to list the member's
    // prefix and converge on the expected index state (queried via the
    // repository; content search over it is US2's surface).
    await waitFor(
      () =>
        calls.includes("ListObjectsV2Command") &&
        getSearchDoc(db, member.id, "users/kate/new report.txt")?.body ===
          "the quokka brigade rides at dawn" &&
        getSearchDoc(db, member.id, "users/kate/gone.txt") === null,
    );
    expect(getSearchDoc(db, member.id, "users/kate/changed.txt")?.body).toBe(
      "fresh",
    );
  });

  it("reindexes the caller's own space the same way (T024)", async () => {
    const store: FakeStore = new Map([
      ["users/admin/notes.txt", { etag: '"a"', size: 6, body: "hello" }],
    ]);
    const { app, db, admin } = createReindexApp(store);

    const res = await reindex(app, admin.id);

    expect(res.status).toBe(202);
    await waitFor(
      () =>
        getSearchDoc(db, admin.id, "users/admin/notes.txt")?.body === "hello",
    );
  });
});
