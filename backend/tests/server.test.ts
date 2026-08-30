import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "bun:test";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession, sessionCookie } from "../src/auth/sessions";
import {
  createApp,
  errorHandler,
  getUser,
  requireUser,
  startSearchIndexer,
} from "../src/server";
import type { ServerEnv } from "../src/server";
import { createSecurityHeadersMiddleware } from "../src/security/headers";
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

// US4 (FR-009/FR-010): every response carries the hardened header set. The
// CSP includes the storage endpoint origin in connect-src (derived from
// config.s3.endpoint) because uploads PUT the file body via XHR directly to
// the storage origin. The fixed headers use exact expected values.
describe("security headers (US4)", () => {
  /** CSP for the shared test config (s3 endpoint origin derived). */
  const cspWithStorage =
    "default-src 'self'; script-src 'self'; style-src 'self' " +
    "'unsafe-inline'; img-src 'self' data:; connect-src 'self' " +
    "https://s3.gra.io.cloud.ovh.net; frame-ancestors 'none'";

  /** CSP when no storage origin is configured (bare middleware). */
  const cspSelfOnly =
    "default-src 'self'; script-src 'self'; style-src 'self' " +
    "'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'";

  /** Assert the exact US4 header set on a response. */
  function expectSecurityHeaders(res: Response, csp: string): void {
    expect(res.headers.get("content-security-policy")).toBe(csp);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  }

  it("sends the full header set on the SPA page", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("JiveDrive SPA");
    expectSecurityHeaders(res, cspWithStorage);
  });

  it("sends the full header set on a JSON 200 response", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/healthcheck");

    expect(res.status).toBe(200);
    expectSecurityHeaders(res, cspWithStorage);
  });

  it("sends the full header set on a 401 response", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    // /api/files/* is guarded by requireUser; without a session cookie the
    // response is a 401 JSON error that must still carry the header set.
    const res = await app.request("/api/files/");

    expect(res.status).toBe(401);
    expectSecurityHeaders(res, cspWithStorage);
  });

  it("sends the full header set on a 404 response", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/api/unknown");

    expect(res.status).toBe(404);
    expectSecurityHeaders(res, cspWithStorage);
  });

  it("sends the full header set on the error handler's 500", async () => {
    // Mirrors the existing error-handler test: a throwing route composed
    // with the real error handler. The headers middleware is registered
    // app-wide first, exactly as in createApp, so even a 500 body carries
    // the set.
    const app = new Hono<ServerEnv>();
    app.use("/*", createSecurityHeadersMiddleware({ nodeEnv: "test" }));
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
    expectSecurityHeaders(res, cspSelfOnly);
  });
});

describe("cache-control on API and auth responses (US4)", () => {
  it("sends Cache-Control: no-store on /api/* responses", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    for (const path of ["/api/files/", "/api/unknown"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("sends Cache-Control: no-store on /auth/* responses", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    for (const path of ["/auth/me", "/auth/nope"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("sends Cache-Control: no-store on the healthcheck", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/healthcheck");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not send Cache-Control: no-store on SPA or static responses", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    for (const path of ["/", "/files", "/assets/app.js"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBeNull();
    }
  });
});

describe("strict transport security (US4)", () => {
  it("does not send Strict-Transport-Security outside production", async () => {
    const app = createApp({ config, db: createDb(), staticDir });
    const res = await app.request("/healthcheck");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("sends Strict-Transport-Security in production", async () => {
    const app = createApp({
      config: { ...config, nodeEnv: "production" },
      db: createDb(),
      staticDir,
    });
    const res = await app.request("/healthcheck");
    expect(res.status).toBe(200);
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("search scan scheduler (T007)", () => {
  /** A stub S3 client serving one listing from an in-memory space. */
  function stubClient(
    objects: Array<{ key: string; etag: string; size: number }>,
  ): {
    client: S3Client;
    calls: Array<{ name: string; input: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = {
      async send(command: unknown): Promise<unknown> {
        const name = (command as { constructor: { name: string } }).constructor
          .name;
        const input =
          (command as { input: Record<string, unknown> }).input ?? {};
        calls.push({ name, input });
        if (name === "ListObjectsV2Command") {
          const prefix = (input.Prefix as string) ?? "";
          return {
            Contents: objects
              .filter((o) => o.key.startsWith(prefix))
              .map((o) => ({
                Key: o.key,
                ETag: o.etag,
                Size: o.size,
                LastModified: new Date(0),
              })),
            IsTruncated: false,
          };
        }
        return { Body: "body" };
      },
    } as unknown as S3Client;
    return { client, calls };
  }

  it("server initialisation registers the scheduler at the configured interval", async () => {
    const db = createDb();
    createUser(db, {
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
    });
    const { client, calls } = stubClient([
      { key: "users/alice/a.txt", etag: '"a"', size: 4 },
    ]);
    const scanConfig: AppConfig = {
      ...config,
      searchScanIntervalSeconds: 1,
    };

    jest.useFakeTimers();
    try {
      const scheduler = startSearchIndexer(scanConfig, db, client);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The bootstrap scan runs at startup, then again each interval.
      expect(calls.some((c) => c.name === "ListObjectsV2Command")).toBe(true);
      const callsAfterBootstrap = calls.length;
      jest.advanceTimersByTime(1000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(calls.length).toBeGreaterThan(callsAfterBootstrap);
      scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
