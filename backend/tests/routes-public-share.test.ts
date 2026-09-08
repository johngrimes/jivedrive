import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createShare, createShareLink, createUser } from "../src/db/repository";
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
function makeConfig(rateLimit?: Partial<AppConfig["rateLimit"]>): AppConfig {
  return {
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
      ...rateLimit,
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
}

const bucket = "jivedrive-prod";

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/**
 * Create an app over a fresh in-memory database with one user (alice,
 * prefix "users/alice/") and no sessions: the public /s route needs no
 * authenticated fixture.
 *
 * @param rateLimit - rate-limit overrides, e.g. a small shareLinks burst
 * @returns app and its database
 */
function createPublicApp(rateLimit?: Partial<AppConfig["rateLimit"]>): {
  app: TestApp;
  db: Database;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  createUser(db, {
    username: "alice",
    bucket,
    prefix: "users/alice/",
  });
  const app = createApp({
    config: makeConfig(rateLimit),
    db,
    s3Client: createS3Client(makeConfig(rateLimit).s3),
  });
  return { app, db };
}

describe("GET /s/:token", () => {
  it("redirects an anonymous caller to a presigned URL for the stored object", async () => {
    const { app, db } = createPublicApp();
    const alice = db
      .query("SELECT id FROM users WHERE username = 'alice'")
      .get() as { id: string };
    const { token } = createShareLink(db, {
      ownerUserId: alice.id,
      bucket,
      objectKey: "users/alice/readme.md",
      expiresIn: "1h",
    });

    // No cookie, no session: the route is public (FR-002).
    const res = await app.request(`/s/${token}`);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/readme.md",
    );
    // D9: the presigned URL minted at click time lives for 5 minutes.
    expect(location).toContain("X-Amz-Expires=300");
    expect(location).toContain("X-Amz-Signature");
  });

  it("serves a link created for a file inside a shared mount", async () => {
    const { app, db } = createPublicApp();
    const alice = db
      .query("SELECT * FROM users WHERE username = 'alice'")
      .get() as { id: string };
    const bob = createUser(db, {
      username: "bob",
      bucket,
      prefix: "users/bob/",
    });
    createShare(db, {
      ownerUserId: alice.id,
      recipientUserId: bob.id,
      folder: "projects",
    });
    // Bob shares plan.txt from alice's mount: the row stores the
    // resolved sharer-side key (D10), not bob's own prefix.
    const { token } = createShareLink(db, {
      ownerUserId: bob.id,
      bucket,
      objectKey: "users/alice/projects/plan.txt",
      expiresIn: "7d",
    });

    const res = await app.request(`/s/${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "https://s3.gra.io.cloud.ovh.net/jivedrive-prod/users/alice/projects/plan.txt",
    );
  });

  /** Seed an already-expired share_links row owned by alice. */
  function seedExpiredLink(db: Database, token: string): void {
    const alice = db
      .query("SELECT id FROM users WHERE username = 'alice'")
      .get() as { id: string };
    const past = new Date(Date.now() - 60_000).toISOString();
    db.query(
      "INSERT INTO share_links (token, ownerUserId, bucket, objectKey, expiresIn, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(token, alice.id, bucket, "users/alice/readme.md", "1h", past, past);
  }

  it("renders the identical 410 page for an expired and an unknown token (FR-005)", async () => {
    const { app, db } = createPublicApp();
    seedExpiredLink(db, "exp1redtoken");

    const expiredRes = await app.request("/s/exp1redtoken");
    const unknownRes = await app.request("/s/zzzzzzzzzzz9");

    expect(expiredRes.status).toBe(410);
    expect(unknownRes.status).toBe(410);
    // D7: a server-rendered HTML page, not a JSON error.
    expect(expiredRes.headers.get("content-type")).toContain("text/html");
    // FR-005: nothing distinguishes expired from never-existed — the
    // bodies are byte-identical.
    const expiredBody = await expiredRes.text();
    const unknownBody = await unknownRes.text();
    expect(expiredBody).toBe(unknownBody);
    // Mobile-usable per D7: a viewport meta and the expiry wording.
    expect(expiredBody).toContain('name="viewport"');
    expect(expiredBody).toContain("expired or does not exist");
  });

  it("lazily deletes an expired row on lookup (D8)", async () => {
    const { app, db } = createPublicApp();
    seedExpiredLink(db, "exp1redtoken");

    await app.request("/s/exp1redtoken");

    // bun:sqlite rows are untyped; this query yields exactly { n }.
    const count = db
      .query("SELECT COUNT(*) AS n FROM share_links WHERE token = ?")
      .get("exp1redtoken") as { n: number };
    expect(count.n).toBe(0);
  });

  it("rate-limits /s/* with a plain 429 that does not hint at token existence", async () => {
    const { app, db } = createPublicApp({
      shareLinksPerMinute: 2,
      shareLinksBurst: 2,
    });
    const alice = db
      .query("SELECT id FROM users WHERE username = 'alice'")
      .get() as { id: string };
    const { token } = createShareLink(
      db,
      {
        ownerUserId: alice.id,
        bucket,
        objectKey: "users/alice/readme.md",
        expiresIn: "1h",
      },
      { tokenFactory: () => "validtoken12" },
    );

    // The burst is consumed by the first two requests (FR-009).
    expect((await app.request(`/s/${token}`)).status).toBe(302);
    expect((await app.request(`/s/${token}`)).status).toBe(302);
    expect((await app.request(`/s/${token}`)).status).toBe(429);
    // A token that never existed is rate-limited identically: the 429
    // reveals nothing about whether a token is live.
    expect((await app.request("/s/garbagegarbg")).status).toBe(429);
  });
});
