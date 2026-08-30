/**
 * Route tests for `GET /api/files/search` (007-file-search, US1 T008,
 * US2 T014 and US3 T019): filename substring search and extracted-content
 * search with snippets across the caller's own space, plus shared-scope
 * search. Follows the fake-S3/client conventions of
 * `routes-files.test.ts`: a real Hono app over a fresh in-memory database
 * with a stubbed S3 client (search never touches S3 — it queries the
 * seeded index).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  createShare,
  createUser,
  deleteShare,
  upsertSearchDoc,
} from "../src/db/repository";
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
const bobCookie = "jivedrive_session=session-token-bob";
const carolCookie = "jivedrive_session=session-token-carol";

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/**
 * Create an app over a fresh in-memory database with three seeded users
 * (alice the sharer, bob the recipient, carol an unrelated third user)
 * and a never-called S3 stub (search is index-only).
 *
 * @returns app, db and the three user rows (for seeding their indexes)
 */
function createSearchApp(): {
  app: TestApp;
  db: Database;
  alice: User;
  bob: User;
  carol: User;
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
  const bob = createUser(db, {
    username: "bob",
    bucket: "jivedrive-prod",
    prefix: "users/bob/",
  });
  createSession(db, bob.id, { token: "session-token-bob" });
  const carol = createUser(db, {
    username: "carol",
    bucket: "jivedrive-prod",
    prefix: "users/carol/",
  });
  createSession(db, carol.id, { token: "session-token-carol" });
  const client = createS3Client(config.s3);
  client.send = (async () => {
    throw new Error("search must never touch S3");
  }) as unknown as S3Client["send"];
  const app = createApp({ config, db, s3Client: client });
  return { app, db, alice, bob, carol };
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

/** Issue a signed search request as the given user's session cookie. */
async function searchAs(
  app: TestApp,
  cookie: string,
  q: string,
): Promise<Response> {
  return app.request(`/api/files/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
}

/** Issue a signed search request as alice. */
async function search(app: TestApp, q: string): Promise<Response> {
  return searchAs(app, aliceCookie, q);
}

describe("GET /api/files/search (US1)", () => {
  it("finds filename substring matches case-insensitively across the own space (T008)", async () => {
    const { app, db, alice, carol } = createSearchApp();
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

    seedDoc(db, carol.id, "users/carol/report.txt", "report.txt");
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

  it("finds indexed content with a marked snippet when the name does not match (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    // The name does not contain the query; the body does (US2).
    seedDoc(
      db,
      alice.id,
      "users/alice/budget.xlsx",
      "budget.xlsx",
      "the quarterly report numbers",
    );

    const res = await search(app, "report");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ match: string; snippet?: string }>;
    };
    expect(body.results[0]?.match).toBe("content");
    expect(body.results[0]?.snippet).toContain("<mark>report</mark>");
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

describe("GET /api/files/search (US2)", () => {
  /** A phrase unique to the US2 fixtures. */
  const PHRASE = "quarterly budget review zephyrquill";

  it("finds a phrase inside an indexed text file with a marked snippet (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(
      db,
      alice.id,
      "users/alice/notes/meeting.txt",
      "meeting.txt",
      `attendees confirmed the ${PHRASE} before noon`,
    );

    const res = await search(app, "budget review");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      name: "meeting.txt",
      path: "notes",
      key: "users/alice/notes/meeting.txt",
      space: "own",
      match: "content",
    });
    // The snippet quotes the document around the match, with the matched
    // phrase wrapped in <mark>...</mark> (FR-005).
    const snippet = String(body.results[0]?.snippet ?? "");
    expect(snippet).toContain("<mark>budget review</mark>");
    expect(snippet.replaceAll(/<\/?mark>/g, "")).toContain(PHRASE);
  });

  it("finds the phrase inside PDF and DOCX documents (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    // Route-level fixtures: the extracted text the scan would have
    // stored (extraction itself is covered by search-extract.test.ts).
    seedDoc(db, alice.id, "users/alice/docs/sample.pdf", "sample.pdf", PHRASE);
    seedDoc(
      db,
      alice.id,
      "users/alice/docs/sample.docx",
      "sample.docx",
      PHRASE,
    );

    const res = await search(app, "zephyrquill");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ match: string; snippet?: string }>;
    };
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result.match).toBe("content");
      expect(result.snippet).toContain("<mark>zephyrquill</mark>");
    }
  });

  it("ranks filename matches above content matches (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/budget.xlsx", "budget.xlsx");
    seedDoc(
      db,
      alice.id,
      "users/alice/a/notes.txt",
      "notes.txt",
      "the budget numbers live here",
    );
    seedDoc(
      db,
      alice.id,
      "users/alice/b/summary.txt",
      "summary.txt",
      "budget again",
    );

    const res = await search(app, "budget");

    const body = (await res.json()) as {
      results: Array<{ name: string; match: string }>;
    };
    expect(body.results[0]).toMatchObject({
      name: "budget.xlsx",
      match: "name",
    });
    // Within the content group the FTS relevance order decides.
    expect(body.results.slice(1).map((r) => r.match)).toEqual([
      "content",
      "content",
    ]);
  });

  it("falls back to filename-only matching for a 1-2 character query (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(
      db,
      alice.id,
      "users/alice/ab-tools.txt",
      "ab-tools.txt",
      "no help",
    );
    seedDoc(
      db,
      alice.id,
      "users/alice/other.txt",
      "other.txt",
      "mentions ab in the body only",
    );

    const res = await search(app, "ab");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    // Only the filename match comes back; the body hit is invisible.
    expect(body.results).toEqual([
      {
        name: "ab-tools.txt",
        path: "",
        key: "users/alice/ab-tools.txt",
        space: "own",
        match: "name",
      },
    ]);
  });

  it("keeps an oversized (name-only) file name-matchable but never content-matches it (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    // Oversized files are indexed by name only (empty body), one byte
    // over the configured cap; at query time an empty body can never
    // produce a content match.
    upsertSearchDoc(db, {
      userId: alice.id,
      key: "users/alice/huge report.pdf",
      etag: '"etag"',
      size: 10_485_761,
      fileName: "huge report.pdf",
      body: "",
    });

    const res = await search(app, "report");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toEqual([
      {
        name: "huge report.pdf",
        path: "",
        key: "users/alice/huge report.pdf",
        space: "own",
        match: "name",
      },
    ]);
  });

  it("returns one name result for a file matching both name and content (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    seedDoc(
      db,
      alice.id,
      "users/alice/report.pdf",
      "report.pdf",
      "%PDF-1.4 hello report",
    );

    const res = await search(app, "report");

    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    // The file ranks as a name match, once — no duplicate content row.
    expect(body.results).toEqual([
      {
        name: "report.pdf",
        path: "",
        key: "users/alice/report.pdf",
        space: "own",
        match: "name",
      },
    ]);
  });

  it("caps the merged list at 50 across both match types (T014)", async () => {
    const { app, db, alice } = createSearchApp();
    for (let i = 0; i < 49; i++) {
      seedDoc(
        db,
        alice.id,
        `users/alice/docs/needle-${String(i).padStart(2, "0")}.txt`,
        `needle-${String(i).padStart(2, "0")}.txt`,
      );
    }
    seedDoc(
      db,
      alice.id,
      "users/alice/a/unrelated1.txt",
      "unrelated1.txt",
      "the needle is hidden in here",
    );
    seedDoc(
      db,
      alice.id,
      "users/alice/b/unrelated2.txt",
      "unrelated2.txt",
      "another needle lives here",
    );

    const res = await search(app, "needle");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ match: string; snippet?: string }>;
      capped: boolean;
    };
    expect(body.capped).toBe(true);
    expect(body.results).toHaveLength(50);
    // Every name match outranks every content match; the second content
    // match is the one dropped by the cap.
    const contentResults = body.results.filter((r) => r.match === "content");
    expect(contentResults).toHaveLength(1);
    expect(contentResults[0]?.snippet).toContain("<mark>needle</mark>");
  });
});

describe("GET /api/files/search (US3)", () => {
  /**
   * Share one of alice's folders with bob and return the stored share.
   *
   * @param db - database connection
   * @param alice - the sharing user
   * @param bob - the recipient
   * @param folder - relative folder in alice's space (normalised)
   */
  function shareWithBob(db: Database, alice: User, bob: User, folder: string) {
    return createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder,
    });
  }

  it("returns the recipient's own matches and the sharer's matches within the shared prefix only (T019)", async () => {
    const { app, db, alice, bob } = createSearchApp();
    // Inside the shared mount: one name match and one content match,
    // the content one nested a folder deeper to prove the mount-relative
    // path mapping.
    seedDoc(db, alice.id, "users/alice/projects/plan.txt", "plan.txt");
    seedDoc(
      db,
      alice.id,
      "users/alice/projects/docs/report.pdf",
      "report.pdf",
      "the plan lives here",
    );
    // Outside the shared mount: must never appear for bob (FR-012).
    seedDoc(
      db,
      alice.id,
      "users/alice/private/secret-plan.txt",
      "secret-plan.txt",
    );
    const share = shareWithBob(db, alice, bob, "projects");

    const res = await searchAs(app, bobCookie, "plan");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
      capped: boolean;
    };
    expect(body.capped).toBe(false);
    // Name match first; keys and paths are mount-relative — identical to
    // what the listing endpoints return in a shared space — and the rows
    // carry the shared space and the sharer's username (FR-010).
    expect(body.results).toEqual([
      {
        name: "plan.txt",
        path: "",
        key: "plan.txt",
        space: `shared:${share.id}`,
        sharedBy: "alice",
        match: "name",
      },
      {
        name: "report.pdf",
        path: "docs",
        key: "docs/report.pdf",
        space: `shared:${share.id}`,
        sharedBy: "alice",
        match: "content",
        snippet: expect.stringContaining("<mark>plan</mark>"),
      },
    ]);
  });

  it("keeps own-space results unchanged (full key, no sharedBy) alongside shared ones (T019)", async () => {
    const { app, db, alice, bob } = createSearchApp();
    seedDoc(db, bob.id, "users/bob/own plan.txt", "own plan.txt");
    seedDoc(db, alice.id, "users/alice/projects/plan.txt", "plan.txt");
    const share = shareWithBob(db, alice, bob, "projects");

    const res = await searchAs(app, bobCookie, "plan");

    const body = (await res.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toEqual([
      {
        name: "own plan.txt",
        path: "",
        key: "users/bob/own plan.txt",
        space: "own",
        match: "name",
      },
      {
        name: "plan.txt",
        path: "",
        key: "plan.txt",
        space: `shared:${share.id}`,
        sharedBy: "alice",
        match: "name",
      },
    ]);
  });
  it("gives a non-recipient nothing from the sharer's space (T019)", async () => {
    const { app, db, alice, bob } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/projects/plan.txt", "plan.txt");
    shareWithBob(db, alice, bob, "projects");

    const res = await searchAs(app, carolCookie, "plan");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it("drops a revoked share's results immediately, without a scan (T019)", async () => {
    const { app, db, alice, bob } = createSearchApp();
    seedDoc(db, alice.id, "users/alice/projects/plan.txt", "plan.txt");
    const share = shareWithBob(db, alice, bob, "projects");

    const live = await searchAs(app, bobCookie, "plan");
    const liveBody = (await live.json()) as { results: unknown[] };
    expect(liveBody.results).toHaveLength(1);

    // Revocation removes the scope at query time: no reindex happens
    // between the two searches (FR-011).
    deleteShare(db, share.id);
    const revoked = await searchAs(app, bobCookie, "plan");
    const revokedBody = (await revoked.json()) as { results: unknown[] };
    expect(revokedBody.results).toEqual([]);
  });

  it("caps the merged own + shared list at 50 across all scopes (T019)", async () => {
    const { app, db, alice, bob } = createSearchApp();
    for (let i = 0; i < 30; i++) {
      seedDoc(
        db,
        bob.id,
        `users/bob/match-${String(i).padStart(2, "0")}.txt`,
        `match-${String(i).padStart(2, "0")}.txt`,
      );
      seedDoc(
        db,
        alice.id,
        `users/alice/projects/match-${String(i).padStart(2, "0")}.txt`,
        `match-${String(i).padStart(2, "0")}.txt`,
      );
    }
    shareWithBob(db, alice, bob, "projects");
    const res = await searchAs(app, bobCookie, "match-");

    const body = (await res.json()) as {
      results: Array<{ space: string; match: string }>;
      capped: boolean;
    };
    expect(body.results).toHaveLength(50);
    expect(body.capped).toBe(true);
    // Every name match outranks every content match; all 50 are name
    // matches here (30 own + 20 shared).
    expect(body.results.every((r) => r.match === "name")).toBe(true);
    expect(body.results.filter((r) => r.space === "own")).toHaveLength(30);
  });
});
