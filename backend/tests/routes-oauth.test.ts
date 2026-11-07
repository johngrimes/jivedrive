import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { Hono as HonoApp } from "hono";
import { requireBearer } from "../src/auth/bearer";
import { createApp } from "../src/server";
import type { ServerEnv } from "../src/server";
import { hashOAuthSecret, pkceS256Challenge } from "../src/oauth";
import { getOAuthClient } from "../src/db/repository";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import {
  ORIGIN,
  REDIRECT_URI,
  RESOURCE,
  VERIFIER,
  approve,
  authorizeUrl,
  config,
  connect,
  createOAuthApp,
  exchangeCode,
  migrationsDir,
  register,
  registerClient,
  startAuthorization,
  tokenRequest,
} from "./oauth-test-helpers";
import type {
  OAuthErrorBody,
  RegistrationBody,
  TestClock,
  TokenBody,
} from "./oauth-test-helpers";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Status of a bearer-protected probe over the same database. */
async function bearerStatus(
  db: Database,
  clock: TestClock,
  token: string,
): Promise<number> {
  const app = new HonoApp<ServerEnv>();
  app.use(
    "*",
    requireBearer(db, config, () => clock.now),
  );
  app.get("/", (c) => c.text("ok"));
  const res = await app.request("/", {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status;
}

/** Count grants in the database. */
function grantCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM oauth_grants").get() as { n: number }
  ).n;
}

/** Read an OAuth error body. */
async function oauthError(res: Response): Promise<string> {
  return ((await res.json()) as OAuthErrorBody).error;
}

describe("metadata endpoints", () => {
  it("serves protected resource metadata at both paths", async () => {
    const { app } = createOAuthApp(databases);
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
        bearer_methods_supported: ["header"],
        scopes_supported: ["drive"],
        resource_name: "JiveDrive",
      });
    }
  });

  it("serves authorization server metadata", async () => {
    const { app } = createOAuthApp(databases);
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("returns JSON 404 for unknown OAuth, well-known and MCP paths even with an SPA", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "jd-spa-"));
    try {
      writeFileSync(join(staticDir, "index.html"), "<p>JiveDrive SPA</p>");
      const db = openDatabase(":memory:");
      migrateFromDir(db, migrationsDir);
      databases.push(db);
      const app = createApp({ config, db, staticDir });
      for (const path of ["/oauth/nope", "/.well-known/nope", "/mcp/nope/x"]) {
        const res = await app.request(path);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: "Not found",
          code: "not_found",
        });
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      // The SPA consent page is not mistaken for an /auth API path.
      const consent = await app.request("/authorize?request=abc");
      expect(consent.status).toBe(200);
      expect(await consent.text()).toContain("JiveDrive SPA");
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe("POST /oauth/register", () => {
  it("registers a public client", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const res = await register(app, {
      client_name: "Claude",
      redirect_uris: [REDIRECT_URI, "http://localhost:6274/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as RegistrationBody;
    expect(body).toEqual({
      client_id: expect.any(String),
      client_id_issued_at: Math.floor(clock.now / 1000),
      client_name: "Claude",
      redirect_uris: [REDIRECT_URI, "http://localhost:6274/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(getOAuthClient(db, body.client_id)?.redirectUris).toEqual([
      REDIRECT_URI,
      "http://localhost:6274/cb",
    ]);
  });

  it("defaults the client name", async () => {
    const { app } = createOAuthApp(databases);
    const res = await register(app, { redirect_uris: [REDIRECT_URI] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as RegistrationBody).client_name).toBe(
      "Unnamed client",
    );
  });

  it("rejects bad redirect URIs", async () => {
    const { app } = createOAuthApp(databases);
    for (const redirect_uris of [
      undefined,
      [],
      "https://x.example/cb",
      ["http://example.com/cb"],
      ["https://x.example/cb#frag"],
      [""],
      [42],
      ["custom-scheme://cb"],
      Array.from({ length: 11 }, (_, i) => `https://x.example/${i}`),
    ]) {
      const res = await register(app, { client_name: "X", redirect_uris });
      expect(res.status).toBe(400);
      expect(await oauthError(res)).toBe("invalid_redirect_uri");
    }
  });

  it("rejects bad client metadata", async () => {
    const { app } = createOAuthApp(databases);
    for (const body of [
      { client_name: "x".repeat(101), redirect_uris: [REDIRECT_URI] },
      { client_name: 7, redirect_uris: [REDIRECT_URI] },
    ]) {
      const res = await register(app, body);
      expect(res.status).toBe(400);
      expect(await oauthError(res)).toBe("invalid_client_metadata");
    }
    const notJson = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(await oauthError(notJson)).toBe("invalid_client_metadata");
  });
});

describe("GET /oauth/authorize", () => {
  it("redirects a valid request to the SPA consent page", async () => {
    const { app, db } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const res = await app.request(authorizeUrl(clientId));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/authorize\?request=[A-Za-z0-9_-]+$/);
    const id = new URL(location, ORIGIN).searchParams.get("request");
    const row = db
      .query("SELECT * FROM oauth_authorization_requests WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      clientId,
      redirectUri: REDIRECT_URI,
      state: "xyz",
      codeChallenge: pkceS256Challenge(VERIFIER),
      resource: RESOURCE,
      scope: "drive",
    });
  });

  it("accepts a request without resource, scope or state", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const res = await app.request(
      authorizeUrl(clientId, { resource: null, scope: null, state: null }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("/authorize?request=");
  });

  it("refuses unknown clients and unregistered redirects without redirecting", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    for (const url of [
      authorizeUrl("unknown-client"),
      authorizeUrl(clientId, { client_id: null }),
      authorizeUrl(clientId, { redirect_uri: "https://evil.example/cb" }),
      authorizeUrl(clientId, { redirect_uri: `${REDIRECT_URI}/` }),
      authorizeUrl(clientId, { redirect_uri: null }),
    ]) {
      const res = await app.request(url);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("redirects other errors back to the client with state and iss", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const cases: Array<[Record<string, string | null>, string]> = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ response_type: null }, "unsupported_response_type"],
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: null }, "invalid_request"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
      [{ scope: "admin" }, "invalid_scope"],
    ];
    for (const [overrides, error] of cases) {
      const res = await app.request(authorizeUrl(clientId, overrides));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe(error);
      expect(location.searchParams.get("error_description")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("xyz");
      expect(location.searchParams.get("iss")).toBe(ORIGIN);
    }
  });
});

describe("POST /oauth/token (authorization_code)", () => {
  it("issues bearer and refresh tokens stored only as hashes", async () => {
    const { app, db } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    const res = await exchangeCode(app, clientId, code);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as TokenBody;
    expect(tokens).toEqual({
      access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: "drive",
    });

    const dump = JSON.stringify(
      [
        "oauth_codes",
        "oauth_access_tokens",
        "oauth_refresh_tokens",
        "oauth_grants",
      ].map((table) => db.query(`SELECT * FROM ${table}`).all()),
    );
    for (const secret of [code, tokens.access_token, tokens.refresh_token]) {
      expect(dump).not.toContain(secret);
      expect(dump).toContain(hashOAuthSecret(secret));
    }
  });

  it("accepts a JSON body and a matching resource", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    const res = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong verifier, redirect or client with invalid_grant", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const otherClient = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: VERIFIER,
    };
    for (const overrides of [
      { code_verifier: `${VERIFIER}x` },
      { redirect_uri: "http://localhost:6274/cb" },
      { client_id: otherClient },
      { code: "not-a-code" },
    ]) {
      const res = await tokenRequest(app, { ...base, ...overrides });
      expect(res.status).toBe(400);
      expect(await oauthError(res)).toBe("invalid_grant");
    }
    // The failed attempts did not burn the code.
    expect((await tokenRequest(app, base)).status).toBe(200);
  });

  it("rejects a code after 60 seconds", async () => {
    const { app, clock } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    clock.now += 60 * 1000;
    const res = await exchangeCode(app, clientId, code);
    expect(res.status).toBe(400);
    expect(await oauthError(res)).toBe("invalid_grant");
  });

  it("revokes the grant when a code is reused", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    const first = await exchangeCode(app, clientId, code);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as TokenBody;
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(200);

    const second = await exchangeCode(app, clientId, code);
    expect(second.status).toBe(400);
    expect(await oauthError(second)).toBe("invalid_grant");
    expect(grantCount(db)).toBe(0);
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(401);
  });

  it("rejects a mismatched resource and missing parameters", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const code = await approve(app, await startAuthorization(app, clientId));
    const target = await tokenRequest(app, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: "https://other.example/mcp",
    });
    expect(target.status).toBe(400);
    expect(await oauthError(target)).toBe("invalid_target");

    const missing = await tokenRequest(app, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
    });
    expect(missing.status).toBe(400);
    expect(await oauthError(missing)).toBe("invalid_request");

    const noGrantType = await tokenRequest(app, { code });
    expect(noGrantType.status).toBe(400);
    expect(await oauthError(noGrantType)).toBe("invalid_request");
  });

  it("rejects other grant types", async () => {
    const { app } = createOAuthApp(databases);
    const res = await tokenRequest(app, {
      grant_type: "client_credentials",
      client_id: "x",
    });
    expect(res.status).toBe(400);
    expect(await oauthError(res)).toBe("unsupported_grant_type");
  });
});

describe("POST /oauth/token (refresh_token)", () => {
  /** Refresh with the given token. */
  function refresh(app: Hono<ServerEnv>, clientId: string, token: string) {
    return tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: clientId,
    });
  }

  it("rotates the refresh token and issues a new access token", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const { clientId, tokens } = await connect(app);
    const res = await refresh(app, clientId, tokens.refresh_token);
    expect(res.status).toBe(200);
    const next = (await res.json()) as TokenBody;
    expect(next.token_type).toBe("Bearer");
    expect(next.expires_in).toBe(3600);
    expect(next.scope).toBe("drive");
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(await bearerStatus(db, clock, next.access_token)).toBe(200);
    // The rotated pair refreshes again.
    expect((await refresh(app, clientId, next.refresh_token)).status).toBe(200);
  });

  it("deletes the grant when a used refresh token is replayed", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const { clientId, tokens } = await connect(app);
    const rotated = (await (
      await refresh(app, clientId, tokens.refresh_token)
    ).json()) as TokenBody;

    const replay = await refresh(app, clientId, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(await oauthError(replay)).toBe("invalid_grant");
    expect(grantCount(db)).toBe(0);
    expect(await bearerStatus(db, clock, rotated.access_token)).toBe(401);
    expect((await refresh(app, clientId, rotated.refresh_token)).status).toBe(
      400,
    );
  });

  it("rejects unknown, expired and other-client refresh tokens", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const { clientId, tokens } = await connect(app);
    const other = await registerClient(app);

    const unknown = await refresh(app, clientId, "nope");
    expect(await oauthError(unknown)).toBe("invalid_grant");

    const mismatch = await refresh(app, other, tokens.refresh_token);
    expect(mismatch.status).toBe(400);
    expect(await oauthError(mismatch)).toBe("invalid_grant");
    expect(grantCount(db)).toBe(1);

    clock.now += 30 * 86400 * 1000;
    const expired = await refresh(app, clientId, tokens.refresh_token);
    expect(expired.status).toBe(400);
    expect(await oauthError(expired)).toBe("invalid_grant");
  });

  it("requires the refresh token and client id", async () => {
    const { app } = createOAuthApp(databases);
    const res = await tokenRequest(app, { grant_type: "refresh_token" });
    expect(res.status).toBe(400);
    expect(await oauthError(res)).toBe("invalid_request");
  });
});

describe("POST /oauth/revoke", () => {
  /** Revoke a token as a client. */
  function revoke(app: Hono<ServerEnv>, params: Record<string, string>) {
    return app.request("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("deletes the grant for the owning client's access or refresh token", async () => {
    for (const kind of ["access_token", "refresh_token"] as const) {
      const { app, db, clock } = createOAuthApp(databases);
      const { clientId, tokens } = await connect(app);
      const res = await revoke(app, {
        token: tokens[kind],
        client_id: clientId,
      });
      expect(res.status).toBe(200);
      expect(grantCount(db)).toBe(0);
      expect(await bearerStatus(db, clock, tokens.access_token)).toBe(401);
    }
  });

  it("returns 200 without revoking for another client or unknown tokens", async () => {
    const { app, db } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const other = await registerClient(app);
    expect(
      (await revoke(app, { token: tokens.access_token, client_id: other }))
        .status,
    ).toBe(200);
    expect(
      (await revoke(app, { token: "nope", client_id: other })).status,
    ).toBe(200);
    expect((await revoke(app, {})).status).toBe(200);
    expect(grantCount(db)).toBe(1);
  });
});

describe("OAuth rate limiting", () => {
  it("limits /oauth/* with the auth family", async () => {
    const limited = {
      ...config,
      rateLimit: { ...config.rateLimit, authPerMinute: 1, authBurst: 1 },
    };
    const { app } = createOAuthApp(databases, { config: limited });
    expect((await app.request("/oauth/authorize?client_id=x")).status).not.toBe(
      429,
    );
    expect((await app.request("/oauth/authorize?client_id=x")).status).toBe(
      429,
    );
  });

  it("limits /api/oauth/* and /mcp with the files family", async () => {
    const limited = {
      ...config,
      rateLimit: { ...config.rateLimit, filesPerMinute: 1, filesBurst: 1 },
    };
    const { app } = createOAuthApp(databases, { config: limited });
    expect((await app.request("/api/oauth/grants")).status).toBe(401);
    expect((await app.request("/api/oauth/grants")).status).toBe(429);
    const second = createOAuthApp(databases, { config: limited });
    expect((await second.app.request("/mcp")).status).not.toBe(429);
    expect((await second.app.request("/mcp")).status).toBe(429);
    const third = createOAuthApp(databases, { config: limited });
    expect((await third.app.request("/mcp/x")).status).not.toBe(429);
    expect((await third.app.request("/mcp/x")).status).toBe(429);
  });
});
