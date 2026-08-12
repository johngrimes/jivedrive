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
import { SESSION_COOKIE_NAME, validateSession } from "./auth/sessions";
import { createChallengeStore } from "./auth/webauthn";
import { authRoutes } from "./routes/auth";
import { filesRoutes } from "./routes/files";
import { adminRoutes } from "./routes/admin";
import { createS3Client } from "./s3/client";

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

  app.get("/healthcheck", (c) => c.json({ status: "ok" }));

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
      requireUser: requireUser(deps.db),
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
      requireUser: requireUser(deps.db),
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
 * signed-in user on the context.
 *
 * @param db - database connection
 * @returns a Hono middleware handler
 */
export function requireUser(db: Database): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) {
      return c.json({ error: "Not signed in", code: "unauthorized" }, 401);
    }
    const session = validateSession(db, token);
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
  const app = createApp({ config, db });
  Bun.serve({ port: config.port, fetch: app.fetch });
  console.log(`JiveDrive listening on http://localhost:${config.port}`);
}

if (import.meta.main) {
  main();
}
