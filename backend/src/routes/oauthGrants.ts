/**
 * OAuth consent and connected-apps routes, mounted under /api/oauth.
 *
 * The SPA consent page (`/authorize?request=<id>`) reads a pending
 * authorization request and approves or denies it; approval creates a
 * grant plus a single-use code and returns the client redirect. The
 * Settings "Connected apps" section lists the caller's grants and revokes
 * one (its tokens cascade, so the client loses access immediately). Every
 * route is guarded by `requireUser` and shares the files-family
 * rate-limit bucket; errors use the `{ error, code }` shape.
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import {
  consumeOAuthAuthorizationRequest,
  createOAuthCode,
  createOAuthGrant,
  deleteOAuthGrant,
  getOAuthAuthorizationRequest,
  getOAuthClient,
  getOAuthGrant,
  listOAuthGrantsByUser,
} from "../db/repository";
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  appendQuery,
  generateOAuthToken,
  hashOAuthSecret,
  oauthIssuer,
} from "../oauth";

/** Dependencies for {@link oauthGrantsRoutes}. */
export interface OAuthGrantsRouteDeps {
  config: AppConfig;
  db: Database;
  /** Middleware that requires a signed-in user and sets `c.get("user")`. */
  requireUser: MiddlewareHandler<ServerEnv>;
  /** Clock in epoch milliseconds (tests); defaults to Date.now. */
  now?: () => number;
}

/**
 * The 404 for an unknown, expired, decided or foreign request or grant.
 *
 * @param c - Hono context
 * @param message - human-readable message
 * @returns a JSON 404 response
 */
function notFound(c: Context<ServerEnv>, message: string): Response {
  return c.json({ error: message, code: "not_found" }, 404);
}

/** Message for a request that cannot be decided any more. */
const REQUEST_GONE = "Authorization request expired or already used";

/**
 * Create the consent and connected-apps routes.
 *
 * @param deps - configuration, database, session middleware and clock
 * @returns a Hono app to mount at /api/oauth
 */
export function oauthGrantsRoutes(deps: OAuthGrantsRouteDeps): Hono<ServerEnv> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const issuer = oauthIssuer(deps.config);
  const app = new Hono<ServerEnv>();
  app.use("*", deps.requireUser);

  app.get("/requests/:id", (c) => {
    const request = getOAuthAuthorizationRequest(
      db,
      c.req.param("id"),
      new Date(now()),
    );
    const client = request ? getOAuthClient(db, request.clientId) : null;
    if (!request || !client) return notFound(c, REQUEST_GONE);
    return c.json({
      id: request.id,
      clientName: client.clientName,
      redirectHost: new URL(request.redirectUri).host,
      expiresAt: request.expiresAt,
    });
  });

  app.post("/requests/:id/approve", (c) => {
    const at = new Date(now());
    const code = generateOAuthToken();
    const request = db.transaction(() => {
      const taken = consumeOAuthAuthorizationRequest(db, c.req.param("id"), at);
      if (!taken) return null;
      const grant = createOAuthGrant(db, {
        id: randomUUID(),
        userId: c.get("user").id,
        clientId: taken.clientId,
        createdAt: at.toISOString(),
      });
      createOAuthCode(db, {
        codeHash: hashOAuthSecret(code),
        grantId: grant.id,
        redirectUri: taken.redirectUri,
        codeChallenge: taken.codeChallenge,
        resource: taken.resource,
        expiresAt: new Date(
          at.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
        ).toISOString(),
      });
      return taken;
    })();
    if (!request) return notFound(c, REQUEST_GONE);
    return c.json({
      redirectTo: appendQuery(request.redirectUri, {
        code,
        state: request.state,
        iss: issuer,
      }),
    });
  });

  app.post("/requests/:id/deny", (c) => {
    const request = consumeOAuthAuthorizationRequest(
      db,
      c.req.param("id"),
      new Date(now()),
    );
    if (!request) return notFound(c, REQUEST_GONE);
    return c.json({
      redirectTo: appendQuery(request.redirectUri, {
        error: "access_denied",
        error_description: "The user denied access",
        state: request.state,
        iss: issuer,
      }),
    });
  });

  app.get("/grants", (c) =>
    c.json({
      grants: listOAuthGrantsByUser(db, c.get("user").id, new Date(now())).map(
        (grant) => ({
          id: grant.id,
          clientName: grant.clientName,
          createdAt: grant.createdAt,
          lastUsedAt: grant.lastUsedAt,
        }),
      ),
    }),
  );

  // Not the caller's grant (or unknown): 404, never revealing existence.
  app.delete("/grants/:id", (c) => {
    const grant = getOAuthGrant(db, c.req.param("id"));
    if (!grant || grant.userId !== c.get("user").id) {
      return notFound(c, "Connected app not found");
    }
    deleteOAuthGrant(db, grant.id);
    return c.body(null, 204);
  });

  return app;
}
