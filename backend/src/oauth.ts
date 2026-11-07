/**
 * Pure helpers for JiveDrive's minimal OAuth 2.1 authorization server,
 * which lets remote MCP clients (Claude custom connectors) act for a
 * signed-in user.
 *
 * The issuer and the MCP resource URL derive from the WebAuthn origin, so
 * no new configuration is needed. Every secret (authorization code,
 * access token, refresh token) is a 32-byte random base64url string that
 * is stored only as its SHA-256 hex digest. PKCE is S256 only.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";

/** The single scope JiveDrive grants: the user's drive. */
export const OAUTH_SCOPE = "drive";

/** Access token lifetime: one hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** Refresh token lifetime, renewed on every rotation: 30 days. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400;

/** Authorization code lifetime: 60 seconds. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** Pending consent request lifetime: 10 minutes. */
export const AUTHORIZATION_REQUEST_TTL_SECONDS = 600;

/** A registered client with no grants is swept after 30 days. */
export const UNUSED_CLIENT_TTL_SECONDS = 30 * 86400;

/** RFC 7636 code verifier: 43-128 unreserved characters. */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** Hosts on which a plain-http redirect URI is allowed (loopback). */
const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "[::1]": true,
};

/**
 * Generate an opaque secret (code or token): 32 random bytes, base64url.
 *
 * @returns a 43-character URL-safe random string
 */
export function generateOAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hash a secret for storage and lookup.
 *
 * @param value - raw code or token
 * @returns its lowercase SHA-256 hex digest
 */
export function hashOAuthSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Compute the PKCE S256 challenge for a verifier (RFC 7636 §4.2).
 *
 * @param verifier - code verifier
 * @returns base64url(SHA-256(verifier)) without padding
 */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Verify a PKCE S256 code verifier against the stored challenge in
 * constant time. Verifiers outside RFC 7636's 43-128 unreserved
 * characters are rejected.
 *
 * @param verifier - code verifier presented at the token endpoint
 * @param challenge - code challenge stored at authorization
 * @returns true when the verifier is well-formed and matches
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER_PATTERN.test(verifier)) return false;
  const expected = Buffer.from(pkceS256Challenge(verifier));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Whether a redirect URI may be registered: an absolute `https:` URL, or
 * `http:` on a loopback host (localhost, 127.0.0.1, [::1]); never with a
 * fragment.
 *
 * @param uri - candidate redirect URI
 * @returns true when the URI is acceptable
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true;
}

/**
 * @param config - application configuration
 * @returns the issuer: the WebAuthn origin without a trailing slash
 */
export function oauthIssuer(config: AppConfig): string {
  return config.webauthn.origin.replace(/\/+$/, "");
}

/**
 * @param config - application configuration
 * @returns the MCP resource URL (`<issuer>/mcp`)
 */
export function mcpResourceUrl(config: AppConfig): string {
  return `${oauthIssuer(config)}/mcp`;
}

/**
 * Build the RFC 9728 protected resource metadata for the MCP endpoint.
 *
 * @param config - application configuration
 * @returns the metadata document
 */
export function buildProtectedResourceMetadata(config: AppConfig) {
  return {
    resource: mcpResourceUrl(config),
    authorization_servers: [oauthIssuer(config)],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: "JiveDrive",
  };
}

/**
 * Build the RFC 8414 authorization server metadata.
 *
 * @param config - application configuration
 * @returns the metadata document
 */
export function buildAuthorizationServerMetadata(config: AppConfig) {
  const issuer = oauthIssuer(config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

/**
 * Build the `WWW-Authenticate` value for a 401 from the MCP endpoint,
 * pointing clients at the protected resource metadata (RFC 9728 §5.1).
 *
 * @param config - application configuration
 * @param invalidToken - whether a token was presented but rejected
 * @returns the header value
 */
export function bearerChallenge(
  config: AppConfig,
  invalidToken: boolean,
): string {
  const base = `Bearer resource_metadata="${oauthIssuer(config)}/.well-known/oauth-protected-resource/mcp"`;
  return invalidToken ? `${base}, error="invalid_token"` : base;
}

/**
 * Append query parameters to a URI, keeping any existing query.
 *
 * @param uri - absolute URI (a registered redirect URI)
 * @param params - parameters to add; null/undefined values are skipped
 * @returns the URI with the parameters appended
 */
export function appendQuery(
  uri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined)
      url.searchParams.append(key, value);
  }
  return url.toString();
}
