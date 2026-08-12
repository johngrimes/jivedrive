import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession, sessionCookie } from "../src/auth/sessions";
import { createApp, errorHandler, getUser, requireUser } from "../src/server";
import type { ServerEnv } from "../src/server";
import type { AppConfig } from "../src/config";
import type { User } from "../src/db/repository";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** A valid config: the S3 credentials are never used by the scaffold. */
const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
  },
  bootstrapAdmin: { username: null, bucket: null, prefix: "", isAdmin: true },
  webauthn: { rpId: "localhost", origin: "http://localhost:5173" },
};

const databases: Database[] = [];
let staticDir = "";

beforeAll(() => {
  staticDir = mkdtempSync(join(tmpdir(), "jivedrive-static-"));
  writeFileSync(
    join(staticDir, "index.html"),
    "<!doctype html><title>JiveDrive SPA</title>",
  );
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "assets", "app.js"), "console.log('app');");
});

afterAll(() => {
  rmSync(staticDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb(): Database {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  return db;
}

describe("healthcheck", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp({ config, db: createDb() });
    const res = await app.request("/healthcheck");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects non-GET methods", async () => {
    const app = createApp({ config, db: createDb() });
    const res = await app.request("/healthcheck", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("static SPA serving", () => {
  it("serves index.html at the root", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JiveDrive SPA");
  });

  it("falls back to index.html for client-side routes", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    for (const path of [
      "/files",
      "/files/sub/dir",
      "/register/invite-token",
      "/admin",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("JiveDrive SPA");
    }
  });

  it("serves static assets with their content", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/assets/app.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('app');");
  });
});

describe("404 handling", () => {
  it("returns a JSON error for unknown API routes", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/api/unknown");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
  });

  it("serves the SPA fallback for unknown non-API routes", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/no/such/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JiveDrive SPA");
  });
});

describe("auth routes", () => {
  it("mounts /auth/me returning null when signed out", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/auth/me");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it("returns a JSON error for unknown auth routes", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/auth/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
  });
});

describe("error handler middleware", () => {
  it("returns a JSON error with a code for thrown exceptions", async () => {
    const app = new Hono<ServerEnv>();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    app.onError(errorHandler());

    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Internal server error",
      code: "internal_error",
    });
  });
});

describe("session auth middleware", () => {
  it("rejects a request without a session cookie", async () => {
    const db = createDb();
    const app = new Hono<ServerEnv>();
    app.use("/protected", requireUser(db));
    app.get("/protected", (c) => c.json({ user: getUser(c).username }));
    app.onError(errorHandler());

    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Not signed in",
      code: "unauthorized",
    });
  });

  it("rejects a request with an unknown session token", async () => {
    const db = createDb();
    const app = new Hono<ServerEnv>();
    app.use("/protected", requireUser(db));
    app.get("/protected", (c) => c.json({ user: getUser(c).username }));
    app.onError(errorHandler());

    const res = await app.request("/protected", {
      headers: { cookie: "jivedrive_session=unknown-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with an expired session", async () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id, {
      now: new Date("2026-08-01T00:00:00Z"),
      ttlDays: 1,
    });

    const app = new Hono<ServerEnv>();
    app.use("/protected", requireUser(db));
    app.get("/protected", (c) => c.json({ user: getUser(c).username }));
    app.onError(errorHandler());

    const res = await app.request("/protected", {
      headers: { cookie: `jivedrive_session=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("passes the signed-in user through to the route", async () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id);

    const app = new Hono<ServerEnv>();
    app.use("/protected", requireUser(db));
    app.get("/protected", (c) => c.json({ user: getUser(c) }));
    app.onError(errorHandler());

    const res = await app.request("/protected", {
      headers: { cookie: `jivedrive_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: User };
    expect(body.user.username).toBe("alice");
    expect(body.user.isAdmin).toBe(false);
  });

  it("accepts a cookie produced by the session cookie helper", async () => {
    const db = createDb();
    const user = createUser(db, {
      username: "alice",
      bucket: "jivedrive-test",
      prefix: "alice/",
    });
    const { token } = createSession(db, user.id);
    const cookie = sessionCookie(token, { maxAgeSeconds: 3600, secure: false });

    const app = new Hono<ServerEnv>();
    app.use("/protected", requireUser(db));
    app.get("/protected", (c) => c.json({ user: getUser(c).username }));
    app.onError(errorHandler());

    const res = await app.request("/protected", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "alice" });
  });
});
