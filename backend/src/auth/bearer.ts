/**
 * Bearer-token authentication for the MCP endpoint.
 *
 * An OAuth access token (issued by /oauth/token) is looked up by its
 * SHA-256 hash; it must be unexpired and its grant must still exist
 * (revoking a grant or deleting the user cascades its tokens away). A
 * failure is a 401 carrying the RFC 9728 `WWW-Authenticate` challenge so
 * MCP clients can discover the authorization server.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import {
  getOAuthAccessToken,
  getOAuthGrant,
  getUserById,
  touchOAuthGrant,
} from "../db/repository";
import { bearerChallenge, hashOAuthSecret } from "../oauth";

/** `Authorization: Bearer <token>`, scheme case-insensitive. */
const BEARER_PATTERN = /^Bearer[ ]+(\S*)\s*$/i;

/**
 * Middleware: validates `Authorization: Bearer <access token>`, sets
 * c.set("user", user) and updates the grant's last_used_at. Without a
 * bearer token the 401 carries the bare challenge; with a token that is
 * unknown, expired or revoked it adds `error="invalid_token"`.
 *
 * @param db - database connection
 * @param config - application configuration (for the challenge URL)
 * @param now - clock in epoch milliseconds (tests); defaults to Date.now
 * @returns a Hono middleware handler
 */
export function requireBearer(
  db: Database,
  config: AppConfig,
  now: () => number = Date.now,
): MiddlewareHandler<ServerEnv> {
  const unauthorized = (
    c: Context<ServerEnv>,
    message: string,
    invalidToken: boolean,
  ): Response => {
    c.header("WWW-Authenticate", bearerChallenge(config, invalidToken));
    return c.json({ error: message, code: "unauthorized" }, 401);
  };

  return async (c, next) => {
    const match = BEARER_PATTERN.exec(c.req.header("authorization") ?? "");
    if (!match) return unauthorized(c, "Missing bearer token", false);
    const at = new Date(now()).toISOString();
    const token = getOAuthAccessToken(db, hashOAuthSecret(match[1] ?? ""));
    const grant =
      token && token.expiresAt > at ? getOAuthGrant(db, token.grantId) : null;
    const user = grant ? getUserById(db, grant.userId) : null;
    if (!grant || !user) {
      return unauthorized(c, "Invalid or expired access token", true);
    }
    touchOAuthGrant(db, grant.id, at);
    c.set("user", user);
    await next();
  };
}
