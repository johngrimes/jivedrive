import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import type { ServerEnv } from "../src/server";
import type { AppConfig } from "../src/config";

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
  ovh: null,
};

const bucket = "jivedrive-prod";

/** The session cookie for a signed-in alice. */
const aliceCookie = "jivedrive_session=session-token-alice";

/** The identity-only user shape per the contract `UserSummary` schema. */
interface UserSummaryBody {
  id: string;
  username: string;
}

/** The response of GET /api/users. */
interface SearchUsersBody {
  users: UserSummaryBody[];
}

/** A Hono app built by {@link createApp}, the test double under test. */
type TestApp = Hono<ServerEnv>;

/**
 * Create an app over a fresh in-memory database seeded with alice (the
 * caller) and a session for her.
 *
 * @returns app, db and alice's id
 */
function createUsersApp(): {
  app: TestApp;
  db: Database;
  aliceId: string;
} {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket,
    prefix: "users/alice/",
  });
  createSession(db, alice.id, { token: "session-token-alice" });
  const app = createApp({ config, db });
  return { app, db, aliceId: alice.id };
}

/**
 * GET the user search endpoint as alice.
 *
 * @param app - the test app
 * @param query - the full query string (e.g. "q=bo"), or "" for none
 * @returns the response
 */
function search(app: TestApp, query = "") {
  return app.request(`/api/users${query === "" ? "" : `?${query}`}`, {
    headers: { cookie: aliceCookie },
  });
}

describe("GET /api/users", () => {
  it("finds users by case-insensitive username substring", async () => {
    const { app, db } = createUsersApp();
    const bob = createUser(db, {
      username: "bob",
      bucket,
      prefix: "users/bob/",
    });

    const upper = await search(app, "q=BO");
    expect(upper.status).toBe(200);
    const upperBody = (await upper.json()) as SearchUsersBody;
    expect(upperBody.users).toEqual([{ id: bob.id, username: "bob" }]);

    const lower = await search(app, "q=bo");
    const lowerBody = (await lower.json()) as SearchUsersBody;
    expect(lowerBody.users).toEqual([{ id: bob.id, username: "bob" }]);
  });

  it("excludes the caller from results", async () => {
    const { app, db } = createUsersApp();
    createUser(db, { username: "alicia", bucket, prefix: "users/alicia/" });

    // "ali" matches both alice (excluded) and alicia (returned).
    const res = await search(app, "q=ali");
    const body = (await res.json()) as SearchUsersBody;
    expect(body.users).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ username: "alicia" });

    // A query matching only the caller returns nothing.
    const exact = await search(app, "q=alice");
    const exactBody = (await exact.json()) as SearchUsersBody;
    expect(exactBody.users).toEqual([]);
  });

  it("exposes only id and username - never bucket, prefix or isAdmin", async () => {
    const { app, db } = createUsersApp();
    createUser(db, {
      username: "bob",
      bucket,
      prefix: "users/bob/",
      isAdmin: true,
    });

    const res = await search(app, "q=b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchUsersBody;
    expect(body.users.length).toBeGreaterThan(0);
    for (const user of body.users) {
      expect(Object.keys(user).sort()).toEqual(["id", "username"]);
      expect(user).toMatchObject({ id: expect.any(String) });
      expect(user).toMatchObject({ username: expect.any(String) });
    }
  });

  it("returns an empty list for an empty q", async () => {
    const { app, db } = createUsersApp();
    createUser(db, { username: "bob", bucket, prefix: "users/bob/" });

    const res = await search(app, "q=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchUsersBody;
    expect(body.users).toEqual([]);
  });

  it("returns an empty list when q is missing", async () => {
    const { app, db } = createUsersApp();
    createUser(db, { username: "bob", bucket, prefix: "users/bob/" });

    const res = await search(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchUsersBody;
    expect(body.users).toEqual([]);
  });

  it("caps results at 20, ordered by username", async () => {
    const { app, db } = createUsersApp();
    // 25 users matching "user" (the caller alice does not match).
    for (let index = 0; index < 25; index += 1) {
      const username = `user${String(index).padStart(2, "0")}`;
      createUser(db, {
        username,
        bucket,
        prefix: `users/${username}/`,
      });
    }

    const res = await search(app, "q=user");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchUsersBody;
    expect(body.users).toHaveLength(20);
    const usernames = body.users.map((user) => user.username);
    expect(usernames[0]).toBe("user00");
    expect(usernames[19]).toBe("user19");
    expect([...usernames].sort()).toEqual(usernames);
  });

  it("requires a session (401)", async () => {
    const { app } = createUsersApp();

    const res = await app.request("/api/users?q=bo");

    expect(res.status).toBe(401);
  });
});
