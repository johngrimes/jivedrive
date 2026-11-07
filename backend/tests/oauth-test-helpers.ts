/**
 * Shared fixtures for the OAuth tests: a config, an app over a fresh
 * in-memory database with two signed-in users and a controllable clock,
 * and helpers that walk the register → authorize → consent → token flow.
 */
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser } from "../src/db/repository";
import { createSession } from "../src/auth/sessions";
import { createApp } from "../src/server";
import type { ServerEnv } from "../src/server";
import type { AppConfig } from "../src/config";
import { pkceS256Challenge } from "../src/oauth";

/** The real migrations directory. */
export const migrationsDir = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** The configured origin (issuer) used by every OAuth test. */
export const ORIGIN = "http://localhost:5173";

/** The MCP resource URL derived from {@link ORIGIN}. */
export const RESOURCE = `${ORIGIN}/mcp`;

/** A redirect URI registered by the default test client. */
export const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** A PKCE verifier (43+ unreserved characters) used by the flow helpers. */
export const VERIFIER = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

/** Cookie headers for the seeded users. */
export const aliceCookie = "jivedrive_session=alice-session";
export const bobCookie = "jivedrive_session=bob-session";

/** A complete test configuration with generous rate limits. */
export const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 10485760,
  rateLimit: {
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
    authPerMinute: 10000,
    authBurst: 10000,
    filesPerMinute: 10000,
    filesBurst: 10000,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.example.test",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  },
  bootstrapAdmin: {
    username: null,
    bucket: null,
    prefix: "",
    isAdmin: true,
    enrollmentToken: null,
  },
  webauthn: { rpId: "localhost", origin: ORIGIN },
  ovh: null,
};

/** A mutable clock in epoch milliseconds. */
export interface TestClock {
  now: number;
}

/** An app under test plus its database, clock and seeded user ids. */
export interface OAuthTestApp {
  app: Hono<ServerEnv>;
  db: Database;
  clock: TestClock;
  aliceId: string;
  bobId: string;
}

/**
 * Create an app over a fresh, migrated in-memory database with alice and
 * bob signed in and a clock the OAuth code reads.
 *
 * @param databases - list that collects the db for closing in afterEach
 * @param options - config override
 * @returns the app, db, clock and user ids
 */
export function createOAuthApp(
  databases: Database[],
  options: { config?: AppConfig } = {},
): OAuthTestApp {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  databases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket: "jivedrive-test",
    prefix: "users/alice/",
  });
  createSession(db, alice.id, { token: "alice-session" });
  const bob = createUser(db, {
    username: "bob",
    bucket: "jivedrive-test",
    prefix: "users/bob/",
  });
  createSession(db, bob.id, { token: "bob-session" });
  const clock: TestClock = { now: Date.parse("2026-11-08T00:00:00.000Z") };
  const app = createApp({
    config: options.config ?? config,
    db,
    oauthNow: () => clock.now,
  });
  return { app, db, clock, aliceId: alice.id, bobId: bob.id };
}

/** The RFC 7591 registration response. */
export interface RegistrationBody {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

/** The successful token response. */
export interface TokenBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** An RFC 6749 error body. */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

/**
 * POST a JSON registration request.
 *
 * @param app - app under test
 * @param body - registration metadata
 * @returns the response
 */
export function register(app: Hono<ServerEnv>, body: unknown) {
  return app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Register a client with {@link REDIRECT_URI} and return its id.
 *
 * @param app - app under test
 * @returns the issued client id
 */
export async function registerClient(app: Hono<ServerEnv>): Promise<string> {
  const res = await register(app, {
    client_name: "Claude",
    redirect_uris: [REDIRECT_URI],
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return ((await res.json()) as RegistrationBody).client_id;
}

/**
 * Build a valid /oauth/authorize URL for a client.
 *
 * @param clientId - registered client id
 * @param overrides - parameters to replace (null removes one)
 * @returns the path with query string
 */
export function authorizeUrl(
  clientId: string,
  overrides: Record<string, string | null> = {},
): string {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceS256Challenge(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz",
    resource: RESOURCE,
    scope: "drive",
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) search.set(key, value);
  }
  return `/oauth/authorize?${search.toString()}`;
}

/**
 * Start an authorization and return the pending request id.
 *
 * @param app - app under test
 * @param clientId - registered client id
 * @returns the authorization request id from the consent redirect
 */
export async function startAuthorization(
  app: Hono<ServerEnv>,
  clientId: string,
): Promise<string> {
  const res = await app.request(authorizeUrl(clientId));
  const location = res.headers.get("location") ?? "";
  const id = new URL(location, ORIGIN).searchParams.get("request");
  if (res.status !== 302 || !id) {
    throw new Error(`authorize failed: ${res.status} ${location}`);
  }
  return id;
}

/**
 * Approve a pending request as the given user and return the code.
 *
 * @param app - app under test
 * @param requestId - pending request id
 * @param cookie - session cookie header
 * @returns the authorization code from the redirect
 */
export async function approve(
  app: Hono<ServerEnv>,
  requestId: string,
  cookie = aliceCookie,
): Promise<string> {
  const res = await app.request(`/api/oauth/requests/${requestId}/approve`, {
    method: "POST",
    headers: { cookie },
  });
  if (res.status !== 200) throw new Error(`approve failed: ${res.status}`);
  const { redirectTo } = (await res.json()) as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw new Error("no code in redirect");
  return code;
}

/**
 * POST a form-encoded token request.
 *
 * @param app - app under test
 * @param params - form fields
 * @returns the response
 */
export function tokenRequest(
  app: Hono<ServerEnv>,
  params: Record<string, string>,
) {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Exchange a code with the default verifier and redirect URI.
 *
 * @param app - app under test
 * @param clientId - client id
 * @param code - authorization code
 * @returns the response
 */
export function exchangeCode(
  app: Hono<ServerEnv>,
  clientId: string,
  code: string,
) {
  return tokenRequest(app, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: VERIFIER,
  });
}

/**
 * Walk the whole flow for alice (or the given cookie) and return tokens.
 *
 * @param app - app under test
 * @param cookie - consenting user's session cookie
 * @returns client id and the issued tokens
 */
export async function connect(
  app: Hono<ServerEnv>,
  cookie = aliceCookie,
): Promise<{ clientId: string; tokens: TokenBody }> {
  const clientId = await registerClient(app);
  const requestId = await startAuthorization(app, clientId);
  const code = await approve(app, requestId, cookie);
  const res = await exchangeCode(app, clientId, code);
  if (res.status !== 200) throw new Error(`token failed: ${res.status}`);
  return { clientId, tokens: (await res.json()) as TokenBody };
}
