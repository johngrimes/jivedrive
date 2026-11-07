/**
 * Security headers on every response (US4, FR-009/FR-010).
 *
 * App-wide middleware that hardens every response the app produces — SPA
 * pages, JSON 200/4xx/401/404, rate-limit 429s and error-handler 500s —
 * so the header set is repo-owned and CI-testable rather than depending on
 * the TLS terminator (research R5).
 *
 * The CSP (research R6) is `default-src 'self'` with styles allowed
 * `'unsafe-inline'` (daisyUI/theming may use inline style attributes) and
 * images from `'self'` or `data:`; no inline scripts exist in the Vite
 * build, so `script-src 'self'` is safe. `connect-src` extends `'self'`
 * with the storage endpoint origin: uploads PUT the file body via XHR
 * directly to the presigned URL on the storage origin, which `connect-src`
 * governs. The FR-009 directives are all still present — this is an
 * extension, not a weakening. The storage origin is derived by server.ts
 * from `config.s3.endpoint`.
 *
 * `Cache-Control: no-store` applies to every API surface ({@link
 * isApiPath}: `/api/*`, `/auth/*`, the OAuth `/oauth/*` and
 * `/.well-known/*` endpoints, `/mcp`) and the healthcheck (FR-010); the
 * SPA itself stays cacheable. HSTS
 * (`max-age=31536000; includeSubDomains`) is sent only in production —
 * the terminator also sends it, and in development plain-HTTP localhost
 * must not pin HTTPS.
 *
 * Headers are set before `await next()` so they survive route handlers
 * that throw: Hono merges the prepared headers into any response created
 * through `c.json`/`c.html`/`c.body`, including the error handler's 500
 * and the not-found handler.
 */
import type { MiddlewareHandler } from "hono";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";

/** HSTS value sent on every production response. */
export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Path prefixes that are API surfaces: JSON 404s and no-store caching. */
const API_PATH_PREFIXES = ["/api", "/auth", "/oauth", "/.well-known", "/mcp"];

/**
 * Whether a request path belongs to an API surface: one of the API
 * prefixes as a whole path segment (so the SPA's `/authorize` consent
 * page is not mistaken for `/auth`), or the healthcheck.
 *
 * @param path - request path
 * @returns true for API paths
 */
export function isApiPath(path: string): boolean {
  return (
    path === "/healthcheck" ||
    API_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

/**
 * Build the Content-Security-Policy value (research R6 plus the
 * storage-origin `connect-src` extension required for direct-to-storage
 * XHR uploads).
 *
 * @param connectSrc - origin of the storage endpoint (e.g.
 *   "https://s3.sgp.io.cloud.ovh.net"); omitted or empty yields
 *   `connect-src 'self'` only
 * @returns the full CSP header value
 */
export function buildContentSecurityPolicy(connectSrc?: string): string {
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' " +
    "'unsafe-inline'; img-src 'self' data:; connect-src 'self'" +
    `${connectSrc ? ` ${connectSrc}` : ""}; frame-ancestors 'none'`
  );
}

/** Options for {@link createSecurityHeadersMiddleware}. */
export interface SecurityHeadersOptions {
  /** Node environment; HSTS is sent only when this is "production". */
  nodeEnv: AppConfig["nodeEnv"];
  /**
   * Origin of the storage endpoint to allow in `connect-src` (the XHR PUT
   * upload target); defaults to none (`connect-src 'self'` only).
   */
  connectSrc?: string;
}

/**
 * Create the app-wide security-headers middleware.
 *
 * Register it ahead of every other middleware and route so every response
 * carries the set. Hono's `use("/*", …)` also covers unmatched paths, so
 * 404 responses are hardened too.
 *
 * @param options - environment and optional storage origin
 * @returns a Hono middleware handler
 */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions,
): MiddlewareHandler<ServerEnv> {
  const csp = buildContentSecurityPolicy(options.connectSrc);
  const sendHsts = options.nodeEnv === "production";

  return async (c, next) => {
    c.header("Content-Security-Policy", csp);
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (isApiPath(c.req.path)) {
      c.header("Cache-Control", "no-store");
    }
    if (sendHsts) {
      c.header("Strict-Transport-Security", HSTS_VALUE);
    }
    await next();
  };
}
