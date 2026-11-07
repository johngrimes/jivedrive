/**
 * OAuth 2.1 authorization server routes for remote MCP clients, mounted
 * at the app root: `/.well-known/*` metadata (RFC 9728, RFC 8414) and
 * `/oauth/*` (RFC 7591 registration, authorization with PKCE S256, the
 * token endpoint with refresh-token rotation, RFC 7009 revocation).
 *
 * Errors use the RFC 6749 `{ error, error_description }` shape. Consent
 * itself happens in the SPA (`/authorize?request=<id>`) through the
 * session-authenticated API in `./oauthGrants.ts`. Codes and tokens are
 * stored only as SHA-256 hashes; reusing a code or a rotated refresh
 * token revokes the whole grant (RFC 6749 §4.1.2, OAuth 2.1 §4.3.1).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import {
  createOAuthAccessToken,
  createOAuthAuthorizationRequest,
  createOAuthClient,
  createOAuthRefreshToken,
  deleteOAuthGrant,
  getOAuthAccessToken,
  getOAuthClient,
  getOAuthCode,
  getOAuthGrant,
  getOAuthRefreshToken,
  markOAuthCodeUsed,
  markOAuthRefreshTokenUsed,
} from "../db/repository";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_REQUEST_TTL_SECONDS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_TTL_SECONDS,
  appendQuery,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  generateOAuthToken,
  hashOAuthSecret,
  isAllowedRedirectUri,
  mcpResourceUrl,
  oauthIssuer,
  verifyPkceS256,
} from "../oauth";

/** Maximum number of redirect URIs one client may register. */
const MAX_REDIRECT_URIS = 10;

/** Maximum client name length, after trimming. */
const MAX_CLIENT_NAME_LENGTH = 100;

/** Name given to a client that does not declare one. */
const DEFAULT_CLIENT_NAME = "Unnamed client";

/** A PKCE S256 challenge: base64url SHA-256 (43 characters). */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Longest `state` accepted at /oauth/authorize (it is stored). */
const MAX_STATE_LENGTH = 1024;

/**
 * Largest request body accepted by the unauthenticated POST endpoints;
 * registration (10 URIs of at most 2048 characters) fits comfortably.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Dependencies for {@link oauthRoutes}. */
export interface OAuthRouteDeps {
  config: AppConfig;
  db: Database;
  /** Clock in epoch milliseconds (tests); defaults to Date.now. */
  now?: () => number;
}

/** A successful token endpoint response. */
interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Build an RFC 6749 JSON error response.
 *
 * @param c - Hono context
 * @param error - OAuth error code
 * @param description - human-readable description
 * @returns a 400 JSON response
 */
function oauthError(
  c: Context<ServerEnv>,
  error: string,
  description: string,
): Response {
  return c.json({ error, error_description: description }, 400);
}

/**
 * Read a form-encoded (or JSON) request body as string parameters;
 * non-string values and unparseable bodies yield no parameters.
 *
 * @param c - Hono context
 * @returns the string-valued parameters
 */
async function readParams(
  c: Context<ServerEnv>,
): Promise<Record<string, string>> {
  let body: unknown;
  try {
    const type = c.req.header("content-type") ?? "";
    body = type.includes("application/json")
      ? await c.req.json()
      : await c.req.parseBody();
  } catch {
    return {};
  }
  const params: Record<string, string> = {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params[key] = value;
    }
  }
  return params;
}

/**
 * Create the OAuth authorization server routes.
 *
 * @param deps - configuration, database and optional clock
 * @returns a Hono app to mount at "/"
 */
export function oauthRoutes(deps: OAuthRouteDeps): Hono<ServerEnv> {
  const { config, db } = deps;
  const now = deps.now ?? Date.now;
  const issuer = oauthIssuer(config);
  const resource = mcpResourceUrl(config);
  const app = new Hono<ServerEnv>();

  /**
   * Issue a fresh access and refresh token pair on a grant.
   *
   * @param grantId - grant the tokens belong to
   * @param at - issue time
   * @returns the token response body
   */
  const issueTokens = (grantId: string, at: Date): TokenResponse => {
    const accessToken = generateOAuthToken();
    const refreshToken = generateOAuthToken();
    createOAuthAccessToken(db, {
      tokenHash: hashOAuthSecret(accessToken),
      grantId,
      expiresAt: new Date(
        at.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000,
      ).toISOString(),
    });
    createOAuthRefreshToken(db, {
      tokenHash: hashOAuthSecret(refreshToken),
      grantId,
      expiresAt: new Date(
        at.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000,
      ).toISOString(),
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    };
  };

  const protectedResource = (c: Context<ServerEnv>) =>
    c.json(buildProtectedResourceMetadata(config));
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(buildAuthorizationServerMetadata(config)),
  );

  // Anonymous endpoints must not accept unbounded bodies (stored rows,
  // memory): over-limit requests get 413 with an RFC 6749-style body.
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        {
          error: "invalid_request",
          error_description: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        },
        413,
      ),
  });

  // RFC 7591 dynamic registration of public clients.
  app.post("/oauth/register", limitBody, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, "invalid_client_metadata", "Body must be JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return oauthError(c, "invalid_client_metadata", "Body must be an object");
    }
    const uris: unknown =
      "redirect_uris" in body ? body.redirect_uris : undefined;
    if (
      !Array.isArray(uris) ||
      uris.length < 1 ||
      uris.length > MAX_REDIRECT_URIS ||
      !uris.every(
        (uri): uri is string =>
          typeof uri === "string" && isAllowedRedirectUri(uri),
      )
    ) {
      return oauthError(
        c,
        "invalid_redirect_uri",
        `redirect_uris must list 1-${MAX_REDIRECT_URIS} https (or loopback http) URLs without fragments`,
      );
    }
    const rawName: unknown =
      "client_name" in body ? body.client_name : undefined;
    if (rawName !== undefined && typeof rawName !== "string") {
      return oauthError(
        c,
        "invalid_client_metadata",
        "client_name must be a string",
      );
    }
    const name = (rawName ?? "").trim();
    if (name.length > MAX_CLIENT_NAME_LENGTH) {
      return oauthError(
        c,
        "invalid_client_metadata",
        `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`,
      );
    }
    const at = now();
    const client = createOAuthClient(db, {
      clientId: randomUUID(),
      clientName: name || DEFAULT_CLIENT_NAME,
      redirectUris: uris,
      createdAt: new Date(at).toISOString(),
    });
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(at / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // Authorization: validate, store the pending request, hand the user to
  // the SPA consent page. Until the client and redirect URI are verified
  // nothing may redirect (an open redirector otherwise).
  app.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const client = q.client_id ? getOAuthClient(db, q.client_id) : null;
    if (!client) {
      return c.text("Authorization failed: unknown client_id.", 400);
    }
    const redirectUri = q.redirect_uri;
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return c.text(
        "Authorization failed: redirect_uri is not registered for this client.",
        400,
      );
    }
    // An oversized state is the invalid parameter, so it is not echoed.
    const stateOk = q.state === undefined || q.state.length <= MAX_STATE_LENGTH;
    const fail = (error: string, description: string) =>
      c.redirect(
        appendQuery(redirectUri, {
          error,
          error_description: description,
          state: stateOk ? q.state : undefined,
          iss: issuer,
        }),
        302,
      );
    if (!stateOk) {
      return fail(
        "invalid_request",
        `state must be at most ${MAX_STATE_LENGTH} characters`,
      );
    }
    if (q.response_type !== "code") {
      return fail("unsupported_response_type", "response_type must be code");
    }
    if (
      !q.code_challenge ||
      !CODE_CHALLENGE_PATTERN.test(q.code_challenge) ||
      q.code_challenge_method !== "S256"
    ) {
      return fail(
        "invalid_request",
        "A PKCE code_challenge with code_challenge_method S256 is required",
      );
    }
    if (q.resource !== undefined && q.resource !== resource) {
      return fail("invalid_target", `resource must be ${resource}`);
    }
    if (q.scope !== undefined && q.scope !== "" && q.scope !== OAUTH_SCOPE) {
      return fail("invalid_scope", `The only scope is ${OAUTH_SCOPE}`);
    }
    const at = now();
    const request = createOAuthAuthorizationRequest(db, {
      id: generateOAuthToken(),
      clientId: client.clientId,
      redirectUri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      resource,
      scope: OAUTH_SCOPE,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(
        at + AUTHORIZATION_REQUEST_TTL_SECONDS * 1000,
      ).toISOString(),
    });
    return c.redirect(`/authorize?request=${request.id}`, 302);
  });

  app.post("/oauth/token", limitBody, async (c) => {
    c.header("Cache-Control", "no-store");
    const params = await readParams(c);
    const at = new Date(now());
    const iso = at.toISOString();
    if (params.resource !== undefined && params.resource !== resource) {
      return oauthError(c, "invalid_target", `resource must be ${resource}`);
    }

    if (params.grant_type === "authorization_code") {
      const { code, redirect_uri, client_id, code_verifier } = params;
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        return oauthError(
          c,
          "invalid_request",
          "code, redirect_uri, client_id and code_verifier are required",
        );
      }
      const codeHash = hashOAuthSecret(code);
      const stored = getOAuthCode(db, codeHash);
      if (stored?.usedAt) {
        // A replayed code may have leaked: revoke what it issued.
        deleteOAuthGrant(db, stored.grantId);
        return oauthError(
          c,
          "invalid_grant",
          "Authorization code already used",
        );
      }
      const grant =
        stored && stored.expiresAt > iso
          ? getOAuthGrant(db, stored.grantId)
          : null;
      if (
        !stored ||
        !grant ||
        grant.clientId !== client_id ||
        stored.redirectUri !== redirect_uri ||
        !verifyPkceS256(code_verifier, stored.codeChallenge)
      ) {
        return oauthError(c, "invalid_grant", "Invalid authorization code");
      }
      const tokens = db.transaction(() =>
        markOAuthCodeUsed(db, codeHash, iso) ? issueTokens(grant.id, at) : null,
      )();
      if (!tokens) {
        return oauthError(
          c,
          "invalid_grant",
          "Authorization code already used",
        );
      }
      return c.json(tokens);
    }

    if (params.grant_type === "refresh_token") {
      const { refresh_token, client_id, scope } = params;
      if (!refresh_token || !client_id) {
        return oauthError(
          c,
          "invalid_request",
          "refresh_token and client_id are required",
        );
      }
      if (scope !== undefined && scope !== "" && scope !== OAUTH_SCOPE) {
        return oauthError(
          c,
          "invalid_scope",
          `The only scope is ${OAUTH_SCOPE}`,
        );
      }
      const tokenHash = hashOAuthSecret(refresh_token);
      const stored = getOAuthRefreshToken(db, tokenHash);
      if (stored?.usedAt) {
        // Reuse of a rotated refresh token: assume theft, revoke the grant.
        deleteOAuthGrant(db, stored.grantId);
        return oauthError(c, "invalid_grant", "Refresh token already used");
      }
      const grant =
        stored && stored.expiresAt > iso
          ? getOAuthGrant(db, stored.grantId)
          : null;
      if (!grant || grant.clientId !== client_id) {
        return oauthError(c, "invalid_grant", "Invalid refresh token");
      }
      const tokens = db.transaction(() =>
        markOAuthRefreshTokenUsed(db, tokenHash, iso)
          ? issueTokens(grant.id, at)
          : null,
      )();
      if (!tokens) {
        return oauthError(c, "invalid_grant", "Refresh token already used");
      }
      return c.json(tokens);
    }

    if (!params.grant_type) {
      return oauthError(c, "invalid_request", "grant_type is required");
    }
    return oauthError(
      c,
      "unsupported_grant_type",
      "grant_type must be authorization_code or refresh_token",
    );
  });

  // RFC 7009: always 200; a token presented by the client that owns it
  // revokes the whole grant (access and refresh tokens alike).
  app.post("/oauth/revoke", limitBody, async (c) => {
    const { token, client_id } = await readParams(c);
    if (token && client_id) {
      const tokenHash = hashOAuthSecret(token);
      const grantId =
        getOAuthAccessToken(db, tokenHash)?.grantId ??
        getOAuthRefreshToken(db, tokenHash)?.grantId;
      const grant = grantId ? getOAuthGrant(db, grantId) : null;
      if (grant && grant.clientId === client_id) {
        deleteOAuthGrant(db, grant.id);
      }
    }
    return c.body(null, 200);
  });

  return app;
}
