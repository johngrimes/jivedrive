/**
 * Route tests for `GET /api/files/search` (007-file-search, US1, T008):
 * filename substring search across the caller's own space. Follows the
 * fake-S3/client conventions of `routes-files.test.ts`: a real Hono app
 * over a fresh in-memory database with a stubbed S3 client (search never
 * touches S3 — it queries the seeded index).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser, upsertSearchDoc } from "../src/db/repository";
import type { User } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import { createS3Client } from "../src/s3/client";
import type { AppConfig } from "../src/config";
import type { Hono } from "hono";
import type { ServerEnv } from "../src/server";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A config whose S3 endpoint is used only for local URL signing. */
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

const aliceCookie = "jivedrive_session=session-token-alice";

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/**
 * Create an app over a fresh in-memory database with a seeded user and a
 * never-called S3 stub (search is index-only).
 *
 * @returns app, db and alice's row (for seeding her index)
 */
function createSearchApp(): {
  app: TestApp;
  db: Database;
  alice: User;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  const client = createS3Client(config.s3);
  client.send = (async () => {
    throw new Error("search must never touch S3");
  }) as unknown as S3Client["send"];
  const app = createApp({ config, db, s3Client: client });
  return { app, db, alice };
}

/**
 * Seed one indexed object into alice's (or another user's) index.
 *
 * @param db - database connection
 * @param userId - owner of the space the object lives in
 * @param key - full object key including the owner's storage prefix
 * @param fileName - base name of the object
 * @param body - extracted text (empty for name-only files)
 */
function seedDoc(
  db: Database,
  userId: string,
  key: string,
  fileName: string,
  body = "",
): void {
  upsertSearchDoc(db, {
    userId,
    key,
    etag: '"etag"',
    size: 10,
    fileName,
    body,
  });
}

/** Issue a signed search request as alice. */
async function search(app: TestApp, q: string): Promise<Response> {
  return app.request(`/api/files/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie: aliceCookie },
  });
}

describe("GET /api/files/search (US1)", () => {
  it("finds filename substring matches case-insensitively across the own space (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(
      db,
      alice.id,
      "users/alice/projects/Q3-Report.pdf",
      "Q3-Report.pdf",
    );
    seedDoc(
      db,
      alice.id,
      "users/alice/notes/report ideas.txt",
      "report ideas.txt",
    );
    seedDoc(db, alice.id, "users/alice/readme.md", "readme.md");
    // Another user's matching file must never leak (constitution IV).

    seedDoc(
      db,
      createUser(db, {
        username: "carol",
        bucket: "jivedrive-prod",
        prefix: "users/carol/",
      }).id,
      "users/carol/report.txt",
      "report.txt",
    );
    const res = await search(app, "report");

    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
      capped: boolean;
    };
    expect(body.capped).toBe(false);
    const sorted = [...body.results].sort((a, b) =>
      String(a.key).localeCompare(String(b.key)),
    );
    // Every result carries exactly the contract shape: name, path, key,
    // space and match (snippet/sharedBy belong to later phases).
    expect(sorted).toEqual([
      {
        name: "report ideas.txt",
        path: "notes",
        key: "users/alice/notes/report ideas.txt",
        space: "own",
        match: "name",
      },
      {
        name: "Q3-Report.pdf",
        path: "projects",
        key: "users/alice/projects/Q3-Report.pdf",
        space: "own",
        match: "name",
      },
    ]);
  });

  it("returns a root file with an empty path (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/REPORT.pdf", "REPORT.pdf");

    const res = await search(app, "report");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toEqual([
      {
        name: "REPORT.pdf",
        path: "",
        key: "users/alice/REPORT.pdf",
        space: "own",
        match: "name",
      },
    ]);
  });

  it("matches only filenames, not indexed content (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    // The name does not contain the query; the body does.
    seedDoc(
      db,
      alice.id,
      "users/alice/budget.xlsx",
      "budget.xlsx",
      "the quarterly report numbers",
    );

    const res = await search(app, "report");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it("answers 400 for a missing or empty-after-trim query (T008)", async () => {
    const { app } = createSearchApp();

    for (const q of [null, "", "   ", "\t\n"]) {
      const url =
        q === null
          ? "/api/files/search"
          : `/api/files/search?q=${encodeURIComponent(q)}`;
      const res = await app.request(url, {
        headers: { cookie: aliceCookie },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
  });

  it("trims surrounding whitespace off a usable query (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/report.pdf", "report.pdf");

    const res = await search(app, "  report  ");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);
  });

  it("answers 400 for a query over the 200-character contract limit (T008)", async () => {
    const { app } = createSearchApp();

    const res = await search(app, "a".repeat(201));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("answers 401 for an unsigned request (T008)", async () => {
    const { app } = createSearchApp();

    const res = await app.request("/api/files/search?q=report");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("is rate-limited under the files family (T008)", async () => {
    const { app } = createSearchApp();
    // config.filesBurst is 100: the first 100 search requests pass, the
    // 101st is refused by the shared /api/files/* token bucket.
    let last: Response | null = null;
    for (let i = 0; i < 101; i++) {
      last = await app.request("/api/files/search?q=report", {
        headers: { cookie: aliceCookie },
      });
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ code: "rate_limited" });
    expect(last?.headers.get("retry-after")).not.toBeNull();
  });

  it("caps results at 50 and sets capped (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    for (let i = 0; i < 55; i++) {
      seedDoc(
        db,
        alice.id,
        `users/alice/docs/match-${String(i).padStart(2, "0")}.txt`,
        `match-${String(i).padStart(2, "0")}.txt`,
      );
    }

    const res = await search(app, "match-");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: unknown[];
      capped: boolean;
    };
    expect(body.results).toHaveLength(50);
    expect(body.capped).toBe(true);
  });

  it("reports capped false when every match fits (T008)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/a.txt", "a.txt");

    const res = await search(app, "a.txt");

    const body = (await res.json()) as { results: unknown[]; capped: boolean };
    expect(body.results).toHaveLength(1);
    expect(body.capped).toBe(false);
  });
});
