import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser, getShareLinkByToken } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import { createS3Client } from "../src/s3/client";
import type { AppConfig } from "../src/config";
import type { Hono } from "hono";
import type { ServerEnv } from "../src/server";
import { createShare, deleteShare } from "../src/db/repository";
import type { ShareLink, User } from "../src/db/repository";

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
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
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

const userPrefix = "users/alice/";
const bucket = "jivedrive-prod";

/**
 * Build an S3 client whose `send` is stubbed but whose config and
 * middleware stack are real, so presigning works without network access.
 *
 * @param handler - receives the command constructor name and input
 * @returns the stubbed S3 client
 */
function stubS3Client(
  handler: (commandName: string, input: Record<string, unknown>) => unknown,
): S3Client {
  const client = createS3Client(config.s3);
  client.send = (async (command: unknown) =>
    handler(
      (command as { constructor: { name: string } }).constructor.name,
      (command as { input: Record<string, unknown> }).input ?? {},
    )) as unknown as S3Client["send"];
  return client;
}

/** The session cookie for a signed-in alice. */
const aliceCookie = "jivedrive_session=session-token-alice";
/** The session cookie for a signed-in bob (the share recipient). */
const bobCookie = "jivedrive_session=session-token-bob";

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/** A stub recording what commands were sent to S3. */
interface CallRecord {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Row counts per table. Deleting an object in storage must never touch
 * the database (data-model.md deletion rules: object deletion leaves
 * all DB records alone).
 *
 * @param db - database connection
 * @returns table name to row count
 */
function dbRowCounts(db: Database): Record<string, number> {
  const tables = ["users", "passkey_credentials", "invites", "sessions"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    counts[table] = row.n;
  }
  return counts;
}

/**
 * Create an app over a fresh in-memory database with a seeded user and a
 * recording S3 stub.
 *
 * @param handler - optional handler; defaults to an empty listing
 * @returns app, db and the recorded S3 calls
 */
function createFilesApp(
  handler?: (commandName: string, input: Record<string, unknown>) => unknown,
): { app: ReturnType<typeof createApp>; db: Database; calls: CallRecord[] } {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: userPrefix,
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  const calls: CallRecord[] = [];
  const client = stubS3Client((name, input) => {
    calls.push({ name, input });
    if (handler) return handler(name, input);
    return { Contents: [], CommonPrefixes: [], IsTruncated: false };
  });
  const app = createApp({ config, db, s3Client: client });
  return { app, db, calls };
}
/**
 * Create an app with three users and two shares: alice shares her
 * `projects` folder with bob (the recipient under test) and her `media`
 * folder with carol (a share bob does not belong to, for foreign-share
 * tests). Both users get sessions, mirroring the aliceCookie pattern.
 *
 * @param handler - optional S3 stub handler
 * @returns app, db, the recorded S3 calls, and the two share ids
 */
function createSharedApp(
  handler?: (commandName: string, input: Record<string, unknown>) => unknown,
): {
  app: TestApp;
  db: Database;
  calls: CallRecord[];
  shareId: string;
  foreignShareId: string;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: userPrefix,
  });
  const bob = createUser(db, {
    username: "bob",
    bucket,
    prefix: "users/bob/",
  });
  const carol = createUser(db, {
    username: "carol",
    bucket,
    prefix: "users/carol/",
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  createSession(db, bob.id, { token: "session-token-bob" });
  const share = createShare(db, {
    ownerUserId: alice.id,
    recipientUserId: bob.id,
    folder: "projects",
  });
  const foreignShare = createShare(db, {
    ownerUserId: alice.id,
    recipientUserId: carol.id,
    folder: "media",
  });
  const calls: CallRecord[] = [];
  const client = stubS3Client((name, input) => {
    calls.push({ name, input });
    if (handler) return handler(name, input);
    return { Contents: [], CommonPrefixes: [], IsTruncated: false };
  });
  const app = createApp({ config, db, s3Client: client });
  return { app, db, calls, shareId: share.id, foreignShareId: foreignShare.id };
}

describe("GET /api/files", () => {
  it("returns folders and files with mapped names, sizes and timestamps", async () => {
    const { app } = createFilesApp((name) => {
      expect(name).toBe("ListObjectsV2Command");
      return {
        Contents: [
          {
            Key: "users/alice/a.txt",
            Size: 10,
            LastModified: new Date("2026-08-12T00:00:00Z"),
          },
          {
            Key: "users/alice/c.txt",
            Size: 20,
            LastModified: new Date("2026-08-13T00:00:00Z"),
          },
        ],
        CommonPrefixes: [{ Prefix: "users/alice/docs/" }],
        IsTruncated: false,
      };
    });

    const res = await app.request("/api/files", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: string[];
      files: Array<{
        key: string;
        name: string;
        size: number;
        lastModified: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.folders).toEqual(["docs"]);
    expect(body.files).toEqual([
      {
        key: "users/alice/a.txt",
        name: "a.txt",
        size: 10,
        lastModified: "2026-08-12T00:00:00.000Z",
      },
      {
        key: "users/alice/c.txt",
        name: "c.txt",
        size: 20,
        lastModified: "2026-08-13T00:00:00.000Z",
      },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("lists a subfolder by joining the relative prefix to the user's prefix", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request("/api/files?prefix=docs/reports", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/docs/reports/",
      Delimiter: "/",
      MaxKeys: 1000,
    });
  });

  it("lists the user's space root when no prefix is given", async () => {
    const { app, calls } = createFilesApp();

    await app.request("/api/files", { headers: { cookie: aliceCookie } });

    expect(calls[0]?.input).toMatchObject({
      Prefix: "users/alice/",
      Delimiter: "/",
    });
  });

  it("passes the cursor through and reports the next cursor", async () => {
    const { app } = createFilesApp((name, input) => {
      expect(name).toBe("ListObjectsV2Command");
      expect(input.ContinuationToken).toBe("token-1");
      return {
        Contents: [],
        CommonPrefixes: [],
        IsTruncated: true,
        NextContinuationToken: "token-2",
      };
    });

    const res = await app.request("/api/files?cursor=token-1", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextCursor: string | null };
    expect(body.nextCursor).toBe("token-2");
  });

  it("returns an empty listing for an empty folder", async () => {
    const { app } = createFilesApp();

    const res = await app.request("/api/files?prefix=empty", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [],
      files: [],
      nextCursor: null,
    });
  });

  it("rejects a prefix that escapes the user's space", async () => {
    const { app, calls } = createFilesApp();

    for (const bad of ["../bob", "/etc", "a/../../bob", "users/../bob"]) {
      const res = await app.request(
        `/api/files?prefix=${encodeURIComponent(bad)}`,
        { headers: { cookie: aliceCookie } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_prefix" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("returns a JSON error for unknown file routes", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files/unknown", {
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });
});

describe("GET /api/files/download-url", () => {
  it("returns a short-lived presigned GET URL without contacting storage", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request(
      "/api/files/download-url?key=users%2Falice%2Fa.txt",
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/a.txt",
    );
    // Short-lived: 15 minutes per the phase contract.
    expect(body.url).toContain("X-Amz-Expires=900");
    expect(body.url).toContain("X-Amz-Signature");
    // The URL is generated without a head request or any storage call.
    expect(calls).toHaveLength(0);
  });

  it("URL-encodes special characters in the key", async () => {
    const { app } = createFilesApp();

    const res = await app.request(
      `/api/files/download-url?key=${encodeURIComponent(
        "users/alice/my file #1?.txt",
      )}`,
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain(encodeURIComponent("my file #1?.txt"));
  });

  it("rejects a key outside the user's prefix", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request(
      "/api/files/download-url?key=users%2Fbob%2Fa.txt",
      { headers: { cookie: aliceCookie } },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a key containing a .. segment without a signed URL (T054)", async () => {
    const { app, calls } = createFilesApp();

    for (const key of ["users/alice/../bob.txt", "users/alice/a/../../x"]) {
      const res = await app.request(
        `/api/files/download-url?key=${encodeURIComponent(key)}`,
        { headers: { cookie: aliceCookie } },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: "out_of_scope" });
      expect(body.url).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing key", async () => {
    const { app } = createFilesApp();

    const res = await app.request("/api/files/download-url", {
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request(
      "/api/files/download-url?key=users%2Falice%2Fa.txt",
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/files/upload-url", () => {
  /** A handler that reports the object as missing (HEAD throws NotFound). */
  function missingHandler(): (
    name: string,
    input: Record<string, unknown>,
  ) => unknown {
    return (name, input) => {
      expect(name).toBe("HeadObjectCommand");
      expect(String(input.Key)).toStartWith(userPrefix);
      const err = new Error("Not Found") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    };
  }

  /** A handler that reports the object as existing with the given size. */
  function existingHandler(size = 42): (name: string) => unknown {
    return (name) => {
      expect(name).toBe("HeadObjectCommand");
      return {
        ContentLength: size,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    };
  }

  /** POST an upload-url request with the alice session cookie. */
  async function postUploadUrl(
    app: ReturnType<typeof createApp>,
    body: unknown,
  ): Promise<Response> {
    return app.request("/api/files/upload-url", {
      method: "POST",
      headers: {
        cookie: aliceCookie,
        "Content-Type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns a short-lived presigned PUT URL for a new file", async () => {
    const { app, calls } = createFilesApp(missingHandler());

    const res = await postUploadUrl(app, {
      folder: "docs",
      fileName: "report.pdf",
      overwrite: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string };
    expect(body.key).toBe("users/alice/docs/report.pdf");
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/docs/report.pdf",
    );
    // Short-lived: 15 minutes per the phase contract.
    expect(body.url).toContain("X-Amz-Expires=900");
    expect(body.url).toContain("X-Amz-Signature");
    // Exactly one storage call: the scoped HEAD for the existence check.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("HeadObjectCommand");
    expect(calls[0]?.input.Key).toBe("users/alice/docs/report.pdf");
  });

  it("builds the key from an empty folder as the user prefix root", async () => {
    const { app, calls } = createFilesApp(missingHandler());

    const res = await postUploadUrl(app, {
      folder: "",
      fileName: "a.txt",
      overwrite: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe("users/alice/a.txt");
    expect(calls[0]?.input.Key).toBe("users/alice/a.txt");
  });

  it("normalises the folder when building the key", async () => {
    const { app, calls } = createFilesApp(missingHandler());

    for (const folder of ["docs", "docs/", "docs/reports"]) {
      const res = await postUploadUrl(app, {
        folder,
        fileName: "a.txt",
        overwrite: false,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { key: string };
      expect(body.key).toBe(`users/alice/${folder.replace(/\/+$/, "")}/a.txt`);
    }
    expect(calls).toHaveLength(3);
  });

  it("preserves file names with spaces and special characters verbatim", async () => {
    const { app } = createFilesApp(missingHandler());

    const res = await postUploadUrl(app, {
      folder: "docs",
      fileName: "my file #1?.txt",
      overwrite: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string };
    // The key stores the name verbatim; the URL carries the encoded form.
    expect(body.key).toBe("users/alice/docs/my file #1?.txt");
    expect(body.url).toContain(encodeURIComponent("my file #1?.txt"));
  });

  it("returns 409 when the object exists and overwrite is not requested", async () => {
    const { app, calls } = createFilesApp(existingHandler(2516582));

    const res = await postUploadUrl(app, {
      folder: "",
      fileName: "report.pdf",
      overwrite: false,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_exists" });
    expect(calls).toHaveLength(1);
  });

  it("returns a presigned PUT URL when overwrite is confirmed", async () => {
    const { app, calls } = createFilesApp(existingHandler(2516582));

    const res = await postUploadUrl(app, {
      folder: "",
      fileName: "report.pdf",
      overwrite: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string };
    expect(body.key).toBe("users/alice/report.pdf");
    expect(body.url).toContain("X-Amz-Signature");
    expect(calls).toHaveLength(1);
  });

  it("rejects a folder that escapes the user's space without touching storage", async () => {
    const { app, calls } = createFilesApp();

    for (const folder of ["../bob", "/etc", "a/../../bob", "users/../bob"]) {
      const res = await postUploadUrl(app, {
        folder,
        fileName: "x.txt",
        overwrite: false,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_folder" });
    }
    // The scoped HEAD must never run against an out-of-scope key.
    expect(calls).toHaveLength(0);
  });

  it("rejects a file name that is not a single base name", async () => {
    const { app, calls } = createFilesApp();

    for (const fileName of ["a/b.txt", ".", "..", ""]) {
      const res = await postUploadUrl(app, {
        folder: "",
        fileName,
        overwrite: false,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_file_name" });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed request body", async () => {
    const { app, calls } = createFilesApp();

    const badBodies: unknown[] = [
      {},
      { folder: "", fileName: "a.txt" },
      { folder: "", overwrite: false },
      { folder: "", fileName: "a.txt", overwrite: "yes" },
      "not json",
    ];
    for (const body of badBodies) {
      const res = await postUploadUrl(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "", fileName: "a.txt", overwrite: false }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/files/share-url", () => {
  /** POST a share-url request with a signed-in session cookie. */
  async function postShareUrl(
    app: TestApp,
    body: unknown,
    cookie = aliceCookie,
  ): Promise<Response> {
    return app.request("/api/files/share-url", {
      method: "POST",
      headers: {
        cookie,
        "Content-Type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  /** Number of share_links rows currently stored. */
  function shareRowCount(db: Database): number {
    return (
      db.query("SELECT COUNT(*) AS n FROM share_links").get() as { n: number }
    ).n;
  }

  /**
   * The share_links row for a token. Fails the test when the row is
   * missing rather than returning undefined.
   */
  function shareRow(db: Database, token: string): ShareLink {
    const row = db
      .query("SELECT * FROM share_links WHERE token = ?")
      .get(token) as ShareLink | undefined;
    if (!row) throw new Error(`No share_links row for token "${token}"`);
    return row;
  }

  /** The user id for a seeded username. */
  function userId(db: Database, username: string): string {
    const user = db
      .query("SELECT * FROM users WHERE username = ?")
      .get(username) as User | undefined;
    if (!user) throw new Error(`No user "${username}" seeded`);
    return user.id;
  }

  it("returns a short link and stores a row with the resolved location", async () => {
    const { app, db, calls } = createFilesApp();

    const before = Date.now();
    const res = await postShareUrl(app, { key: "users/alice/readme.md" });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    // FR-001: the link is the app origin plus /s/ and a 12-char token.
    expect(body.url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/);
    // FR-003: the link carries no storage provider, bucket, prefix or key.
    expect(body.url).not.toContain("s3.gra.io.cloud.ovh.net");
    expect(body.url).not.toContain("jivedrive-prod");
    expect(body.url).not.toContain("users/alice");
    expect(body.url).not.toContain("readme");
    // Generation never contacts storage (US4 scenario 5: a missing
    // object is refused later, when the link is opened).
    expect(calls).toHaveLength(0);

    // The row stores the resolved bucket/key and the owning user.
    const token = body.url.slice(-12);
    expect(shareRow(db, token)).toMatchObject({
      bucket,
      objectKey: "users/alice/readme.md",
      ownerUserId: userId(db, "alice"),
      expiresIn: "7d",
    });
    // Default expiry: 7 days out, and exactly the row's expiresAt.
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 604800_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 604800_000);
    expect(shareRow(db, token).expiresAt).toBe(body.expiresAt);
  });

  it("honours every expiresIn choice for its full duration (FR-004)", async () => {
    const { app } = createFilesApp();

    // 30 days is 2592000 seconds: no 7-day presigned-URL cap (FR-004).
    const cases: Array<[string, number]> = [
      ["1h", 3600_000],
      ["24h", 86400_000],
      ["7d", 604800_000],
      ["30d", 2592000_000],
    ];

    for (const [expiresIn, durationMs] of cases) {
      const before = Date.now();
      const res = await postShareUrl(app, {
        key: "users/alice/readme.md",
        expiresIn,
      });
      const after = Date.now();

      expect(res.status).toBe(200);
      const body = (await res.json()) as { expiresAt: string };
      const expiresAt = new Date(body.expiresAt).getTime();
      // The response's expiresAt is exactly the chosen lifetime out:
      // never shorter (the old 30d→7d cap) and never longer.
      expect(expiresAt - before).toBeGreaterThanOrEqual(durationMs);
      expect(expiresAt - after).toBeLessThanOrEqual(durationMs);
    }
  });

  it("stores the sharer-resolved location for a shared-mount file", async () => {
    const { app, db, shareId } = createSharedApp();

    const res = await postShareUrl(
      app,
      { space: `shared:${shareId}`, key: "plan.txt" },
      bobCookie,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/);
    // The mount-relative key resolves to the sharer's full object key,
    // and the link's owner is its creator (bob), not the sharer.
    expect(shareRow(db, body.url.slice(-12))).toMatchObject({
      bucket,
      objectKey: "users/alice/projects/plan.txt",
      ownerUserId: userId(db, "bob"),
    });
  });

  it("rejects keys outside the scope with 400 and stores no row", async () => {
    const { app, db, calls } = createFilesApp();

    for (const key of [
      "users/bob/a.txt",
      "users/alice2/x.txt",
      "users/alice/../bob.txt",
      "users/alice/a/../../x",
    ]) {
      const res = await postShareUrl(app, { key });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    }
    expect(calls).toHaveLength(0);
    expect(shareRowCount(db)).toBe(0);
  });

  it("rejects unknown, foreign and revoked shared spaces with 404 and stores no row", async () => {
    const { app, db, shareId, foreignShareId } = createSharedApp();

    // A share id that was never issued.
    const unknown = await postShareUrl(
      app,
      { space: "shared:no-such-share", key: "x.txt" },
      bobCookie,
    );
    expect(unknown.status).toBe(404);
    // A share that exists but does not belong to the caller (carol's).
    const foreign = await postShareUrl(
      app,
      { space: `shared:${foreignShareId}`, key: "x.txt" },
      bobCookie,
    );
    expect(foreign.status).toBe(404);
    // A share revoked after creation.
    deleteShare(db, shareId);
    const revoked = await postShareUrl(
      app,
      { space: `shared:${shareId}`, key: "plan.txt" },
      bobCookie,
    );
    expect(revoked.status).toBe(404);

    expect(shareRowCount(db)).toBe(0);
  });

  it("rejects a missing or empty key", async () => {
    const { app, db } = createFilesApp();

    for (const body of [{}, { key: "" }]) {
      const res = await postShareUrl(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
    expect(shareRowCount(db)).toBe(0);
  });

  it("rejects an invalid expiresIn and stores no row", async () => {
    const { app, db, calls } = createFilesApp();

    const badExpiries: unknown[] = ["2h", "7", "7 days", 7, null, true];
    for (const expiresIn of badExpiries) {
      const res = await postShareUrl(app, {
        key: "users/alice/a.txt",
        expiresIn,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_expiry" });
    }
    expect(calls).toHaveLength(0);
    expect(shareRowCount(db)).toBe(0);
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "users/alice/a.txt" }),
    });
    expect(res.status).toBe(401);
  });
  it("returns the same active link for the same file and lifetime (FR-006)", async () => {
    const { app, db } = createFilesApp();

    const first = await postShareUrl(app, {
      key: "users/alice/readme.md",
      expiresIn: "7d",
    });
    const second = await postShareUrl(app, {
      key: "users/alice/readme.md",
      expiresIn: "7d",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as {
      url: string;
      expiresAt: string;
    };
    const secondBody = (await second.json()) as {
      url: string;
      expiresAt: string;
    };
    // Reopening the modal re-shows the same link with its remaining
    // lifetime, and no duplicate row is created.
    expect(secondBody.url).toBe(firstBody.url);
    expect(secondBody.expiresAt).toBe(firstBody.expiresAt);
    expect(shareRowCount(db)).toBe(1);
  });

  it("serves distinct lifetimes concurrently for the same file (FR-006)", async () => {
    const { app, db } = createFilesApp();

    const shortRes = await postShareUrl(app, {
      key: "users/alice/readme.md",
      expiresIn: "1h",
    });
    const longRes = await postShareUrl(app, {
      key: "users/alice/readme.md",
      expiresIn: "30d",
    });

    const shortBody = (await shortRes.json()) as { url: string };
    const longBody = (await longRes.json()) as { url: string };
    // A different lifetime is a different link; both rows exist.
    expect(longBody.url).not.toBe(shortBody.url);
    expect(shareRowCount(db)).toBe(2);
    // Both tokens resolve to a live row for the same file.
    for (const body of [shortBody, longBody]) {
      const row = getShareLinkByToken(db, body.url.slice(-12));
      expect(row?.objectKey).toBe("users/alice/readme.md");
      expect(row?.token).toBe(body.url.slice(-12));
    }
  });

  it("mints a new token after the previous link expired (FR-006)", async () => {
    const { app, db } = createFilesApp();

    const first = await postShareUrl(app, { key: "users/alice/readme.md" });
    const firstBody = (await first.json()) as { url: string };
    const firstToken = firstBody.url.slice(-12);
    // Age the row past its expiry the way the sweep would.
    db.query("UPDATE share_links SET expiresAt = ? WHERE token = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      firstToken,
    );

    const second = await postShareUrl(app, { key: "users/alice/readme.md" });
    const secondBody = (await second.json()) as { url: string };

    expect(second.status).toBe(200);
    expect(secondBody.url).not.toBe(firstBody.url);
    // The expired row was replaced, not duplicated.
    expect(shareRowCount(db)).toBe(1);
  });
});

describe("DELETE /api/files", () => {
  /** DELETE a file key with the alice session cookie. */
  async function deleteFile(
    app: ReturnType<typeof createApp>,
    key: string,
  ): Promise<Response> {
    return app.request(`/api/files?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });
  }

  it("deletes an existing object and returns 204 with no body", async () => {
    const { app, calls } = createFilesApp((name, input) => {
      // The delete command is answered with an empty payload; the head
      // command reports the object as existing.
      if (name === "DeleteObjectCommand") return {};
      expect(name).toBe("HeadObjectCommand");
      expect(String(input.Key)).toBe("users/alice/old.txt");
      return {
        ContentLength: 10,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    });

    const res = await deleteFile(app, "users/alice/old.txt");

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    // The scoped HEAD runs first, then the delete on the same key.
    expect(calls.map((c) => c.name)).toEqual([
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(calls[1]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/old.txt",
    });
  });

  it("returns 404 for a missing object and never deletes", async () => {
    const { app, calls } = createFilesApp((name, input) => {
      expect(name).toBe("HeadObjectCommand");
      expect(String(input.Key)).toBe("users/alice/gone.txt");
      const err = new Error("Not Found") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    });

    const res = await deleteFile(app, "users/alice/gone.txt");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
    // No delete is attempted for an object that does not exist.
    expect(calls.map((c) => c.name)).toEqual(["HeadObjectCommand"]);
  });

  it("rejects a key outside the user's prefix without touching storage", async () => {
    const { app, calls } = createFilesApp();

    for (const key of ["users/bob/a.txt", "users/alice2/x.txt"]) {
      const res = await deleteFile(app, key);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    }
    // No head or delete ever runs against an out-of-scope key.
    expect(calls).toHaveLength(0);
  });

  it("rejects a key containing a .. segment without touching storage (T054)", async () => {
    const { app, calls } = createFilesApp();

    for (const key of ["users/alice/../bob.txt", "users/alice/a/../../x"]) {
      const res = await deleteFile(app, key);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    }
    // No head or delete ever runs against a key with a traversal segment.
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing key", async () => {
    const { app, calls } = createFilesApp();

    const res = await app.request("/api/files", {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it("persists nothing: the database is untouched by delete requests", async () => {
    const { app, db } = createFilesApp((name) => {
      // The object exists, so the delete proceeds.
      if (name === "DeleteObjectCommand") return {};
      expect(name).toBe("HeadObjectCommand");
      return {
        ContentLength: 10,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    });

    const before = dbRowCounts(db);
    // A successful delete must leave every table unchanged (deleting an
    // object in storage does not touch any database records).
    await deleteFile(app, "users/alice/a.txt");

    expect(dbRowCounts(db)).toEqual(before);
  });

  it("requires a signed-in session", async () => {
    const { app } = createFilesApp();
    const res = await app.request("/api/files?key=users%2Falice%2Fa.txt", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
describe("space-aware file operations (T007)", () => {
  /** An unknown share id: well-formed UUID that resolves to nothing. */
  const unknownShareId = "11111111-1111-4111-8111-111111111111";

  /** Encode a space value for a query string. */
  const spaceParam = (space: string) => `space=${encodeURIComponent(space)}`;

  it("treats an absent space exactly as own for the signed-in user", async () => {
    const { app, calls } = createSharedApp();

    const res = await app.request("/api/files", {
      headers: { cookie: bobCookie },
    });

    expect(res.status).toBe(200);
    // bob's own space: his prefix, not alice's.
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/bob/",
    });
  });

  it("accepts an explicit space=own", async () => {
    const { app, calls } = createSharedApp();

    const res = await app.request("/api/files?space=own", {
      headers: { cookie: bobCookie },
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.input).toMatchObject({ Prefix: "users/bob/" });
  });

  it("lists the sharer's contents with mount-relative keys, own prefix ignored", async () => {
    const { app, calls, shareId } = createSharedApp((name) => {
      expect(name).toBe("ListObjectsV2Command");
      return {
        Contents: [
          {
            Key: "users/alice/projects/plan.txt",
            Size: 10,
            LastModified: new Date("2026-08-12T00:00:00Z"),
          },
          {
            Key: "users/alice/projects/report.pdf",
            Size: 20,
            LastModified: new Date("2026-08-13T00:00:00Z"),
          },
        ],
        CommonPrefixes: [{ Prefix: "users/alice/projects/docs/" }],
        IsTruncated: false,
      };
    });

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
    // The listing runs against the sharer's effective prefix.
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/projects/",
      Delimiter: "/",
    });
    const body = (await res.json()) as {
      folders: string[];
      files: Array<{
        key: string;
        name: string;
        size: number;
        lastModified: string;
      }>;
    };
    // Keys are relative to the mount: the sharer's prefix never leaks.
    expect(body.folders).toEqual(["docs"]);
    expect(body.files).toEqual([
      {
        key: "plan.txt",
        name: "plan.txt",
        size: 10,
        lastModified: "2026-08-12T00:00:00.000Z",
      },
      {
        key: "report.pdf",
        name: "report.pdf",
        size: 20,
        lastModified: "2026-08-13T00:00:00.000Z",
      },
    ]);
  });

  it("issues a download URL for the sharer's bucket and key from a mount-relative key", async () => {
    const { app, calls, shareId } = createSharedApp();

    const res = await app.request(
      `/api/files/download-url?${spaceParam(
        `shared:${shareId}`,
      )}&key=${encodeURIComponent("plan.txt")}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    // The mount-relative key composes to the sharer's full key.
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/plan.txt",
    );
    expect(body.url).toContain("X-Amz-Expires=900");
    // Presigning contacts no storage.
    expect(calls).toHaveLength(0);
  });

  it("presigns an upload under the sharer's prefix in a shared space", async () => {
    const { app, calls, shareId } = createSharedApp((name) => {
      expect(name).toBe("HeadObjectCommand");
      const err = new Error("Not Found") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    });

    const res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: {
        cookie: bobCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        space: `shared:${shareId}`,
        folder: "",
        fileName: "notes.txt",
        overwrite: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string };
    // Mount-relative: the sharer's internal prefix never leaks into the
    // client (R2), matching the FileEntry key semantics of shared listings.
    expect(body.key).toBe("notes.txt");
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/notes.txt",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.Key).toBe("users/alice/projects/notes.txt");
  });

  it("returns 409 for an existing file in a shared space without overwrite", async () => {
    const { app, calls, shareId } = createSharedApp((name) => {
      expect(name).toBe("HeadObjectCommand");
      return {
        ContentLength: 2516582,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    });

    const res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: {
        cookie: bobCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        space: `shared:${shareId}`,
        folder: "docs",
        fileName: "report.pdf",
        overwrite: false,
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "already_exists" });
    expect(calls[0]?.input.Key).toBe("users/alice/projects/docs/report.pdf");
  });

  it("deletes an object from the sharer's space in a shared space", async () => {
    const { app, calls, shareId } = createSharedApp((name, input) => {
      if (name === "DeleteObjectCommand") return {};
      expect(name).toBe("HeadObjectCommand");
      expect(String(input.Key)).toBe("users/alice/projects/notes.txt");
      return {
        ContentLength: 10,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    });

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}&key=${encodeURIComponent(
        "notes.txt",
      )}`,
      {
        method: "DELETE",
        headers: { cookie: bobCookie },
      },
    );

    expect(res.status).toBe(204);
    expect(calls.map((c) => c.name)).toEqual([
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(calls[1]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/projects/notes.txt",
    });
  });

  it("generates a share link for a key in a shared space", async () => {
    const { app, calls, db, shareId } = createSharedApp();

    const res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: {
        cookie: bobCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ space: `shared:${shareId}`, key: "plan.txt" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/);
    expect(calls).toHaveLength(0);
    const row = db
      .query("SELECT * FROM share_links WHERE token = ?")
      .get(body.url.slice(-12)) as { objectKey: string } | undefined;
    expect(row?.objectKey).toBe("users/alice/projects/plan.txt");
  });

  it("rejects a key escaping the shared folder with 400 out_of_scope", async () => {
    const { app, calls, shareId } = createSharedApp();

    for (const key of ["..", "../x", "a/../../b"]) {
      const res = await app.request(
        `/api/files/download-url?${spaceParam(
          `shared:${shareId}`,
        )}&key=${encodeURIComponent(key)}`,
        { headers: { cookie: bobCookie } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    }
    // No storage call ever runs against an out-of-scope key.
    expect(calls).toHaveLength(0);
  });

  it("returns 404 for an unknown share on every operation", async () => {
    const { app, calls } = createSharedApp();
    const space = `shared:${unknownShareId}`;

    let res = await app.request(`/api/files?${spaceParam(space)}`, {
      headers: { cookie: bobCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });

    res = await app.request(
      `/api/files/download-url?${spaceParam(space)}&key=${encodeURIComponent(
        "plan.txt",
      )}`,
      { headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        space,
        folder: "",
        fileName: "a.txt",
        overwrite: false,
      }),
    });
    expect(res.status).toBe(404);

    res = await app.request(
      `/api/files?${spaceParam(space)}&key=${encodeURIComponent("plan.txt")}`,
      { method: "DELETE", headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ space, key: "plan.txt" }),
    });
    expect(res.status).toBe(404);

    expect(calls).toHaveLength(0);
  });

  it("returns 404 for a foreign share on every operation", async () => {
    const { app, calls, foreignShareId } = createSharedApp();
    // alice shared this folder with carol; bob is not its recipient.
    const space = `shared:${foreignShareId}`;

    let res = await app.request(`/api/files?${spaceParam(space)}`, {
      headers: { cookie: bobCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });

    res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        space,
        folder: "",
        fileName: "a.txt",
        overwrite: false,
      }),
    });
    expect(res.status).toBe(404);

    res = await app.request(
      `/api/files/download-url?${spaceParam(space)}&key=${encodeURIComponent(
        "plan.txt",
      )}`,
      { headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request(
      `/api/files?${spaceParam(space)}&key=${encodeURIComponent("plan.txt")}`,
      { method: "DELETE", headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ space, key: "plan.txt" }),
    });
    expect(res.status).toBe(404);

    expect(calls).toHaveLength(0);
  });

  it("returns 404 for a revoked share on every operation", async () => {
    const { app, db, calls, shareId } = createSharedApp();
    deleteShare(db, shareId);
    const space = `shared:${shareId}`;

    let res = await app.request(`/api/files?${spaceParam(space)}`, {
      headers: { cookie: bobCookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });

    res = await app.request(
      `/api/files/download-url?${spaceParam(space)}&key=${encodeURIComponent(
        "plan.txt",
      )}`,
      { headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        space,
        folder: "",
        fileName: "a.txt",
        overwrite: false,
      }),
    });
    expect(res.status).toBe(404);

    res = await app.request(
      `/api/files?${spaceParam(space)}&key=${encodeURIComponent("plan.txt")}`,
      { method: "DELETE", headers: { cookie: bobCookie } },
    );
    expect(res.status).toBe(404);

    res = await app.request("/api/files/share-url", {
      method: "POST",
      headers: { cookie: bobCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ space, key: "plan.txt" }),
    });
    expect(res.status).toBe(404);

    expect(calls).toHaveLength(0);
  });

  it("returns 400 for a malformed space value on every operation", async () => {
    const { app, calls } = createSharedApp();

    for (const space of ["", "foo", "shared:", "shared:.."]) {
      let res = await app.request(`/api/files?${spaceParam(space)}`, {
        headers: { cookie: bobCookie },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });

      res = await app.request(
        `/api/files/download-url?${spaceParam(space)}&key=${encodeURIComponent(
          "plan.txt",
        )}`,
        { headers: { cookie: bobCookie } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });

      res = await app.request(
        `/api/files?${spaceParam(space)}&key=${encodeURIComponent("plan.txt")}`,
        { method: "DELETE", headers: { cookie: bobCookie } },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });

      res = await app.request("/api/files/upload-url", {
        method: "POST",
        headers: { cookie: bobCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          space,
          folder: "",
          fileName: "a.txt",
          overwrite: false,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });

      res = await app.request("/api/files/share-url", {
        method: "POST",
        headers: { cookie: bobCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ space, key: "plan.txt" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
    expect(calls).toHaveLength(0);
  });
});
describe("shared-space listing and download (T022)", () => {
  /** Encode a space value for a query string. */
  const spaceParam = (space: string) => `space=${encodeURIComponent(space)}`;

  it("lists an empty shared folder as an empty page (no error)", async () => {
    // The default stub returns no Contents and no CommonPrefixes, which
    // is exactly the empty-folder shape (US2 scenario 3).
    const { app, calls, shareId } = createSharedApp();

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      folders: [],
      files: [],
      nextCursor: null,
    });
    // The listing still ran against the sharer's folder, not the root.
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/projects/",
    });
  });

  it("lists a subfolder inside the mount with a mount-relative prefix", async () => {
    const { app, calls, shareId } = createSharedApp((name) => {
      expect(name).toBe("ListObjectsV2Command");
      return {
        Contents: [
          {
            Key: "users/alice/projects/docs/report.pdf",
            Size: 20,
            LastModified: new Date("2026-08-13T00:00:00Z"),
          },
        ],
        CommonPrefixes: [],
        IsTruncated: false,
      };
    });

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}&prefix=${encodeURIComponent("docs/")}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
    // The mount-relative prefix composes onto the sharer's folder
    // server-side: the client never sends the sharer's internal prefix.
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/projects/docs/",
      Delimiter: "/",
    });
    const body = (await res.json()) as {
      folders: string[];
      files: Array<{
        key: string;
        name: string;
        size: number;
        lastModified: string;
      }>;
    };
    expect(body.folders).toEqual([]);
    expect(body.files).toEqual([
      {
        key: "docs/report.pdf",
        name: "report.pdf",
        size: 20,
        lastModified: "2026-08-13T00:00:00.000Z",
      },
    ]);
    // Keys stay relative to the mount root (contract: "relative to the
    // shared folder"), matching the own-space convention where keys are
    // relative to the space root; the SPA downloads them verbatim.
    expect(body.files[0]?.key).toBe("docs/report.pdf");
  });

  it("never applies the caller's own prefix to a shared-space listing", async () => {
    const { app, shareId } = createSharedApp((name, input) => {
      expect(name).toBe("ListObjectsV2Command");
      // The listing runs against the sharer's composed prefix; bob's own
      // space identity must never leak into the S3 call (R2).
      expect(String(input.Prefix)).toBe("users/alice/projects/");
      expect(String(input.Prefix).startsWith("users/bob/")).toBe(false);
      return { Contents: [], CommonPrefixes: [], IsTruncated: false };
    });

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
  });

  it("issues a download URL for a key inside a mount subfolder", async () => {
    const { app, calls, shareId } = createSharedApp();

    const res = await app.request(
      `/api/files/download-url?${spaceParam(`shared:${shareId}`)}&key=${encodeURIComponent("docs/report.pdf")}`,
      { headers: { cookie: bobCookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    // The mount-relative key composes to the full sharer-side key.
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/docs/report.pdf",
    );
    expect(body.url).toContain("X-Amz-Expires=900");
    // Presigning contacts no storage.
    expect(calls).toHaveLength(0);
  });
});

describe("shared-space upload and delete (T026)", () => {
  /** Encode a space value for a query string. */
  const spaceParam = (space: string) => `space=${encodeURIComponent(space)}`;

  /** A handler that reports the object as existing with the given size. */
  function existingHandler(size = 2516582): (name: string) => unknown {
    return (name) => {
      expect(name).toBe("HeadObjectCommand");
      return {
        ContentLength: size,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    };
  }

  it("presigns an overwrite PUT for an existing file in a shared space", async () => {
    const { app, calls, shareId } = createSharedApp(existingHandler());

    const res = await app.request("/api/files/upload-url", {
      method: "POST",
      headers: {
        cookie: bobCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        space: `shared:${shareId}`,
        folder: "docs",
        fileName: "report.pdf",
        overwrite: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; key: string };
    // Mount-relative key; the presigned PUT targets the sharer's full key.
    expect(body.key).toBe("docs/report.pdf");
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/docs/report.pdf",
    );
    expect(body.url).toContain("X-Amz-Signature");
    // Overwrite consent skips the 409: exactly one scoped HEAD ran, on
    // the sharer's full key (US3 sc.3).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.Key).toBe("users/alice/projects/docs/report.pdf");
  });

  it("refuses an existing file without overwrite, then presigns the replace once confirmed", async () => {
    const { app, calls, shareId } = createSharedApp(existingHandler());

    const post = (overwrite: boolean) =>
      app.request("/api/files/upload-url", {
        method: "POST",
        headers: {
          cookie: bobCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          space: `shared:${shareId}`,
          folder: "",
          fileName: "notes.txt",
          overwrite,
        }),
      });

    // Without consent the existing object is refused with 409 (US3 sc.2).
    const refused = await post(false);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "already_exists" });

    // With consent the replace is presigned against the sharer's key
    // (US3 sc.3): the same object, no 409.
    const confirmed = await post(true);
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as { url: string; key: string };
    expect(body.key).toBe("notes.txt");
    expect(body.url).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/notes.txt",
    );
    expect(calls.map((c) => c.name)).toEqual([
      "HeadObjectCommand",
      "HeadObjectCommand",
    ]);
    expect(calls[1]?.input.Key).toBe("users/alice/projects/notes.txt");
  });

  it("rejects an upload folder that escapes the shared folder without touching storage", async () => {
    const { app, calls, shareId } = createSharedApp();

    // The folder composes onto the sharer's prefix server-side; any ".."
    // segment or absolute path must be refused before a key is formed
    // (FR-012): parent traversal can never widen the mount's scope.
    for (const folder of ["..", "../x", "../../x", "a/../../b"]) {
      const res = await app.request("/api/files/upload-url", {
        method: "POST",
        headers: {
          cookie: bobCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          space: `shared:${shareId}`,
          folder,
          fileName: "x.txt",
          overwrite: false,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_folder" });
    }
    // The scoped HEAD must never run against an out-of-scope key.
    expect(calls).toHaveLength(0);
  });

  it("deletes an object inside the shared folder with the sharer's full key", async () => {
    const { app, calls, shareId } = createSharedApp((name, input) => {
      if (name === "DeleteObjectCommand") return {};
      expect(name).toBe("HeadObjectCommand");
      expect(String(input.Key)).toBe("users/alice/projects/notes.txt");
      return {
        ContentLength: 10,
        LastModified: new Date("2026-08-12T00:00:00Z"),
      };
    });

    const res = await app.request(
      `/api/files?${spaceParam(`shared:${shareId}`)}&key=${encodeURIComponent(
        "notes.txt",
      )}`,
      {
        method: "DELETE",
        headers: { cookie: bobCookie },
      },
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(calls.map((c) => c.name)).toEqual([
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);
    expect(calls[1]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/projects/notes.txt",
    });
  });

  it("rejects a delete key that escapes the shared folder", async () => {
    const { app, calls, shareId } = createSharedApp();

    // The mount-relative key composes onto the sharer's folder server-side
    // ("users/alice/projects/" + key); assertKeyInScope then refuses the
    // composed key for parent traversal or a prefix escape (FR-012).
    for (const key of [
      "..",
      "../outside.txt",
      "../../outside.txt",
      "a/../../b",
    ]) {
      const res = await app.request(
        `/api/files?${spaceParam(`shared:${shareId}`)}&key=${encodeURIComponent(
          key,
        )}`,
        {
          method: "DELETE",
          headers: { cookie: bobCookie },
        },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "out_of_scope" });
    }
    // No HEAD, no DELETE: the refusal happens before any storage call.
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/files/folders", () => {
  /**
   * A handler for a folder that does not exist yet: the existence probe
   * lists nothing and the marker PUT succeeds.
   */
  function newFolderHandler(): (name: string) => unknown {
    return (name) => {
      if (name === "ListObjectsV2Command") return { IsTruncated: false };
      expect(name).toBe("PutObjectCommand");
      return {};
    };
  }

  /** POST a create-folder request with a signed-in session cookie. */
  async function postFolder(
    app: TestApp,
    body: unknown,
    cookie = aliceCookie,
  ): Promise<Response> {
    return app.request("/api/files/folders", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a folder marker at the root of the own space", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    const res = await postFolder(app, { folder: "", name: "Reports" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: "Reports", prefix: "Reports/" });
    // Probe first, then exactly one zero-byte marker write.
    expect(calls.map((call) => call.name)).toEqual([
      "ListObjectsV2Command",
      "PutObjectCommand",
    ]);
    expect(calls[0]?.input).toMatchObject({
      Bucket: bucket,
      Prefix: "users/alice/Reports/",
    });
    expect(calls[1]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/Reports/",
      ContentLength: 0,
    });
  });

  it("creates a nested folder, normalising the parent folder", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    for (const folder of ["docs", "docs/", "docs//"]) {
      const res = await postFolder(app, { folder, name: "2026" });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ name: "2026", prefix: "docs/2026/" });
    }
    const keys = calls
      .filter((call) => call.name === "PutObjectCommand")
      .map((call) => call.input.Key);
    expect(keys).toEqual([
      "users/alice/docs/2026/",
      "users/alice/docs/2026/",
      "users/alice/docs/2026/",
    ]);
  });

  it("trims the name and keeps spaces and special characters verbatim", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    const res = await postFolder(app, { folder: "", name: "  My stuff #1?  " });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      name: "My stuff #1?",
      prefix: "My stuff #1?/",
    });
    expect(calls[1]?.input.Key).toBe("users/alice/My stuff #1?/");
  });

  it("refuses a name already used by a folder without writing", async () => {
    const { app, calls } = createFilesApp((name) => {
      expect(name).toBe("ListObjectsV2Command");
      // A folder made only of nested files (no marker) still exists.
      return {
        Contents: [{ Key: "users/alice/docs/a.txt" }],
        IsTruncated: true,
      };
    });

    const res = await postFolder(app, { folder: "", name: "docs" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A folder named "docs" already exists',
      code: "already_exists",
    });
    expect(calls.map((call) => call.name)).toEqual(["ListObjectsV2Command"]);
  });

  it("allows a folder named like an existing file (S3 keeps X and X/ apart)", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    const res = await postFolder(app, { folder: "", name: "notes.txt" });

    expect(res.status).toBe(201);
    // The probe looks under "notes.txt/" only, never at the file key.
    expect(calls[0]?.input.Prefix).toBe("users/alice/notes.txt/");
  });

  it("rejects invalid names without touching storage", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    for (const name of [
      "",
      "   ",
      ".",
      "..",
      " .. ",
      "a/b",
      "/",
      "trailing/",
      "x".repeat(256),
    ]) {
      const res = await postFolder(app, { folder: "", name });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_folder_name" });
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts a name of exactly 255 characters, counted after trimming", async () => {
    const { app } = createFilesApp(newFolderHandler());

    const longest = "é".repeat(255);
    const res = await postFolder(app, { folder: "", name: ` ${longest} ` });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ name: longest, prefix: `${longest}/` });
  });

  it("rejects a parent folder that escapes the space without touching storage", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    for (const folder of ["../bob", "/etc", "a/../../bob", ".."]) {
      const res = await postFolder(app, { folder, name: "x" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_folder" });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed request body", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    const badBodies: unknown[] = [
      {},
      { folder: "" },
      { name: "x" },
      { folder: 1, name: "x" },
      { folder: "", name: 7 },
      { folder: "", name: "x", space: 5 },
      "not json",
    ];
    for (const body of badBodies) {
      const res = await postFolder(app, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "bad_request" });
    }
    expect(calls).toHaveLength(0);
  });

  it("requires a signed-in session", async () => {
    const { app, calls } = createFilesApp(newFolderHandler());

    const res = await app.request("/api/files/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "", name: "x" }),
    });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("creates a folder inside a shared folder with the sharer's full key", async () => {
    const { app, calls, shareId } = createSharedApp(newFolderHandler());

    const res = await postFolder(
      app,
      { space: `shared:${shareId}`, folder: "docs", name: "drafts" },
      bobCookie,
    );

    expect(res.status).toBe(201);
    // Mount-relative prefix: the sharer's internal prefix never leaks (R2).
    expect(await res.json()).toEqual({
      name: "drafts",
      prefix: "docs/drafts/",
    });
    expect(calls[0]?.input.Prefix).toBe("users/alice/projects/docs/drafts/");
    expect(calls[1]?.input).toMatchObject({
      Bucket: bucket,
      Key: "users/alice/projects/docs/drafts/",
    });
  });

  it("refuses foreign, unknown and malformed spaces without touching storage", async () => {
    const { app, calls, foreignShareId } = createSharedApp(newFolderHandler());

    for (const space of [`shared:${foreignShareId}`, "shared:nope"]) {
      const res = await postFolder(
        app,
        { space, folder: "", name: "x" },
        bobCookie,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    }
    const malformed = await postFolder(
      app,
      { space: "shared:", folder: "", name: "x" },
      bobCookie,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a parent folder that escapes the shared folder", async () => {
    const { app, calls, shareId } = createSharedApp(newFolderHandler());

    for (const folder of ["..", "../x", "a/../../b"]) {
      const res = await postFolder(
        app,
        { space: `shared:${shareId}`, folder, name: "x" },
        bobCookie,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_folder" });
    }
    expect(calls).toHaveLength(0);
  });
});
