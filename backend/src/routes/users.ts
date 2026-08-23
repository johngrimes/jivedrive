/**
 * User search route: `GET /api/users?q=` lets any signed-in user find a
 * share recipient by username (FR-006, R4), implemented per
 * `contracts/openapi.yaml` (T018).
 *
 * The match is a case-insensitive username substring, the caller is
 * excluded, and at most 20 results are returned. The payload is
 * identity-only (`{ id, username }`) — never bucket, prefix or admin
 * status. An empty or missing `q` returns an empty list. The route is
 * guarded by `requireUser` and shares the files-family rate-limit bucket
 * (R7).
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import type { ServerEnv } from "../server";
import { searchUsers } from "../db/repository";

/** Dependencies for {@link usersRoutes}. */
export interface UsersRouteDeps {
  /** Database for the user search. */
  db: Database;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
}

/**
 * Create the user route module mounted under /api/users.
 *
 * @param deps - database and auth middleware
 * @returns a Hono app with the user search route
 */
export function usersRoutes(deps: UsersRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  app.use("*", deps.requireUser);

  app.get("/", (c) => {
    const user = c.get("user");
    const query = (c.req.query("q") ?? "").trim();
    if (query === "") {
      return c.json({ users: [] }, 200);
    }
    return c.json({ users: searchUsers(deps.db, query, user.id) }, 200);
  });

  return app;
}
