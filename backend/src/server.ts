import { Hono } from "hono";
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { serveStatic } from "hono/bun";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "./config";
import type { AppConfig } from "./config";
import { migrateFromDir, openDatabase } from "./db/migrate";
import { bootstrapAdmin } from "./db/bootstrap";
import { getUserById } from "./db/repository";
import type { User } from "./db/repository";
import {
  SESSION_COOKIE_NAME,
  sweepExpiredSessions,
  validateSession,
} from "./auth/sessions";
import { createChallengeStore } from "./auth/webauthn";
import { authRoutes } from "./routes/auth";
import { filesRoutes } from "./routes/files";
import { adminRoutes } from "./routes/admin";
import { createS3Client } from "./s3/client";
import { createRateLimitMiddleware, createRateLimitStore } from "./security/rateLimit";
import { createSecurityHeadersMiddleware } from "./security/headers";

/** Variables stored on the Hono context for the current request. */
export type ServerEnv = {
  Variables: {
    user: User;
  };
};

/** Dependencies for {@link createApp}. */
export interface ServerDeps {
  config: AppConfig;
  db: Database;
  /** Directory of the built SPA; defaults to CWD/frontend/dist. */
  staticDir?: string;
  /** S3 client for file operations; defaults to one built from config. */
  s3Client?: S3Client;
  /** Folder listing page size; defaults to 1000 (S3's page size). */
  listPageSize?: number;
  /**
   * Injectable clock for the rate limiter (tests); defaults to Date.now.
   * Mirrors the s3Client/listPageSize injection pattern.
   */
  rateLimitNow?: () => number;
}

/**
 * Create the Hono application: healthcheck, middleware wiring, and
 * static serving of the built SPA with a client-side route fallback.
 *
 * Unknown `/api/*` and `/healthcheck` routes return a JSON 404; other
 * unknown routes fall back to the SPA's index.html.
 *
 * @param deps - configuration, database and static directory
 * @returns the configured Hono app
 */
export function createApp(deps: ServerDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.onError(errorHandler());

  // Security headers (FR-009/FR-010): app-wide, registered before every
  // other middleware and route so every response — SPA page, JSON 200/4xx,
  // 401/404/429, error-handler 500 — carries the hardened set. connect-src
  // extends 'self' with the storage endpoint origin because uploads PUT
  // the file body via XHR directly to the presigned URL on that origin;
  // without it the CSP would block uploads (the e2e upload spec would
  // break under `default-src 'self'`).
  app.use(
    "/*",
    createSecurityHeadersMiddleware({
      nodeEnv: deps.config.nodeEnv,
      connectSrc: new URL(deps.config.s3.endpoint).origin,
    }),
  );

  app.get("/healthcheck", (c) => c.json({ status: "ok" }));

  // Rate limiting (FR-007/FR-008): per-client-identity token buckets for
  // the auth and file API families. Registered before the route groups so a
  // 429 never reaches a route handler (no challenge or state consumed).
  // One store is shared by both families so the size cap bounds total
  // memory; the healthcheck and static/SPA paths are never limited.
  const rateLimitStore = createRateLimitStore();
  app.use(
    "/auth/*",
    createRateLimitMiddleware(deps.config, "auth", {
      now: deps.rateLimitNow,
      store: rateLimitStore,
    }),
  );
  app.use(
    "/api/files/*",
    createRateLimitMiddleware(deps.config, "files", {
      now: deps.rateLimitNow,
      store: rateLimitStore,
    }),
  );

  // Auth routes (passkey registration, sign-in, logout, current user),
  // mounted under /auth per the API contract.
  app.route(
    "/auth",
    authRoutes({
      config: deps.config,
      db: deps.db,
      challenges: createChallengeStore(),
    }),
  );

  // File routes (folder listing, download URLs) mounted under /api/files.
  // The S3 client is injectable so tests can substitute a stub or mock.
  app.route(
    "/api/files",
    filesRoutes({
      s3Client: deps.s3Client ?? createS3Client(deps.config.s3),
      requireUser: requireUser(deps.db, deps.config.sessionIdleDays),
      listPageSize: deps.listPageSize,
    }),
  );

  // Admin routes (user and invite management) mounted under /api/admin.
  // The requireUser middleware plus an admin check guards every route
  // (FR-015); the admin routes have no S3 dependency (FR-014).
  app.route(
    "/api/admin",
    adminRoutes({
      config: deps.config,
      db: deps.db,
      requireUser: requireUser(deps.db, deps.config.sessionIdleDays),
    }),
  );

  // Static SPA serving, mounted only when the build output exists. In
  // development the Vite dev server serves the SPA instead.
  const staticDir = deps.staticDir ?? resolve(process.cwd(), "frontend/dist");
  let indexHtml: string | null = null;
  if (existsSync(staticDir)) {
    const indexPath = join(staticDir, "index.html");
    if (existsSync(indexPath)) indexHtml = readFileSync(indexPath, "utf8");
    app.use("/*", serveStatic({ root: staticDir }));
  }

  app.notFound((c) => {
    const isApi =
      c.req.path.startsWith("/api") ||
      c.req.path.startsWith("/auth") ||
      c.req.path === "/healthcheck";
    if (isApi || indexHtml === null) {
      return c.json({ error: "Not found", code: "not_found" }, 404);
    }
    return c.html(indexHtml);
  });

  return app;
}

/**
 * Error handler that turns thrown exceptions into a JSON error body.
 *
 * @returns a Hono error handler
 */
export function errorHandler(): ErrorHandler<ServerEnv> {
  return (err, c) => {
    console.error(err);
    return c.json(
      { error: "Internal server error", code: "internal_error" },
      500,
    );
  };
}

/**
 * Middleware that requires a valid session cookie and stores the
 * signed-in user on the context. Sessions are validated with the idle
 * timeout (FR-011): an absolute- or idle-expired session is rejected and
 * lazily purged.
 *
 * @param db - database connection
 * @param idleDays - session idle timeout in days, defaults to 7
 * @returns a Hono middleware handler
 */
export function requireUser(
  db: Database,
  idleDays = 7,
): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) {
      return c.json({ error: "Not signed in", code: "unauthorized" }, 401);
    }
    const session = validateSession(db, token, undefined, idleDays);
    if (!session) {
      return c.json(
        { error: "Session expired or invalid", code: "unauthorized" },
        401,
      );
    }
    const user = getUserById(db, session.userId);
    if (!user) {
      return c.json({ error: "User not found", code: "unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  };
}

/**
 * Read the signed-in user from the request context.
 *
 * @param c - Hono context
 * @returns the user set by {@link requireUser}
 */
export function getUser(c: Context<ServerEnv>): User {
  return c.get("user");
}

/**
 * Load configuration, open and migrate the database, and start the server.
 * Runs when this module is the entry point.
 */
export function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  migrateFromDir(db, config.migrationsDir);
  bootstrapAdmin(db, config.bootstrapAdmin);
  // FR-011: purge absolute- and idle-expired sessions in a sweep at
  // startup so dead rows do not accumulate between lazy purges.
  sweepExpiredSessions(db, undefined, config.sessionIdleDays);
  const app = createApp({ config, db });
  Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`JiveDrive listening on http://localhost:${config.port}`);
}

if (import.meta.main) {
  main();
}
