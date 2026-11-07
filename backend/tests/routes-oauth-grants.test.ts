import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { requireBearer } from "../src/auth/bearer";
import { deleteUser, touchOAuthGrant } from "../src/db/repository";
import type { ServerEnv } from "../src/server";
import {
  ORIGIN,
  REDIRECT_URI,
  aliceCookie,
  approve,
  bobCookie,
  config,
  connect,
  createOAuthApp,
  exchangeCode,
  registerClient,
  startAuthorization,
} from "./oauth-test-helpers";
import type { TestClock, TokenBody } from "./oauth-test-helpers";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A consent request summary. */
interface RequestBody {
  id: string;
  clientName: string;
  redirectHost: string;
  expiresAt: string;
}

/** One connected app. */
interface GrantBody {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Status of a bearer-protected probe over the same database. */
async function bearerStatus(
  db: Database,
  clock: TestClock,
  token: string,
): Promise<number> {
  const app = new Hono<ServerEnv>();
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

describe("consent API", () => {
  it("requires a session", async () => {
    const { app } = createOAuthApp(databases);
    const id = await startAuthorization(app, await registerClient(app));
    expect((await app.request(`/api/oauth/requests/${id}`)).status).toBe(401);
    for (const action of ["approve", "deny"]) {
      const res = await app.request(`/api/oauth/requests/${id}/${action}`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    }
  });

  it("describes a pending request", async () => {
    const { app, clock } = createOAuthApp(databases);
    const id = await startAuthorization(app, await registerClient(app));
    const res = await app.request(`/api/oauth/requests/${id}`, {
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as RequestBody).toEqual({
      id,
      clientName: "Claude",
      redirectHost: "claude.ai",
      expiresAt: new Date(clock.now + 600 * 1000).toISOString(),
    });
  });

  it("404s unknown and expired requests", async () => {
    const { app, clock } = createOAuthApp(databases);
    const id = await startAuthorization(app, await registerClient(app));
    const unknown = await app.request("/api/oauth/requests/nope", {
      headers: { cookie: aliceCookie },
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: expect.any(String),
      code: "not_found",
    });
    clock.now += 600 * 1000;
    for (const [path, method] of [
      [`/api/oauth/requests/${id}`, "GET"],
      [`/api/oauth/requests/${id}/approve`, "POST"],
      [`/api/oauth/requests/${id}/deny`, "POST"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { cookie: aliceCookie },
      });
      expect(res.status).toBe(404);
    }
  });

  it("approve redirects with a code that exchanges exactly once", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const id = await startAuthorization(app, clientId);
    const res = await app.request(`/api/oauth/requests/${id}/approve`, {
      method: "POST",
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const redirect = new URL(
      ((await res.json()) as { redirectTo: string }).redirectTo,
    );
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    const code = redirect.searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect((await exchangeCode(app, clientId, code)).status).toBe(200);
    expect((await exchangeCode(app, clientId, code)).status).toBe(400);
  });

  it("deny redirects with access_denied and creates no grant", async () => {
    const { app, db } = createOAuthApp(databases);
    const id = await startAuthorization(app, await registerClient(app));
    const res = await app.request(`/api/oauth/requests/${id}/deny`, {
      method: "POST",
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const redirect = new URL(
      ((await res.json()) as { redirectTo: string }).redirectTo,
    );
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    expect(redirect.searchParams.get("code")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM oauth_grants").get()).toEqual({
      n: 0,
    });
  });

  it("404s a request that was already decided", async () => {
    const { app } = createOAuthApp(databases);
    const clientId = await registerClient(app);
    const approved = await startAuthorization(app, clientId);
    await approve(app, approved);
    const denied = await startAuthorization(app, clientId);
    await app.request(`/api/oauth/requests/${denied}/deny`, {
      method: "POST",
      headers: { cookie: aliceCookie },
    });
    for (const id of [approved, denied]) {
      for (const [path, method] of [
        [`/api/oauth/requests/${id}`, "GET"],
        [`/api/oauth/requests/${id}/approve`, "POST"],
        [`/api/oauth/requests/${id}/deny`, "POST"],
      ] as const) {
        const res = await app.request(path, {
          method,
          headers: { cookie: aliceCookie },
        });
        expect(res.status).toBe(404);
      }
    }
  });
});

describe("connected apps API", () => {
  it("requires a session", async () => {
    const { app } = createOAuthApp(databases);
    expect((await app.request("/api/oauth/grants")).status).toBe(401);
    expect(
      (await app.request("/api/oauth/grants/x", { method: "DELETE" })).status,
    ).toBe(401);
  });

  it("lists only the caller's grants, newest first", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const created1 = new Date(clock.now).toISOString();
    await connect(app);
    clock.now += 1000;
    const created2 = new Date(clock.now).toISOString();
    await connect(app);
    await connect(app, bobCookie);

    const res = await app.request("/api/oauth/grants", {
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(200);
    const { grants } = (await res.json()) as { grants: GrantBody[] };
    expect(grants).toEqual([
      {
        id: expect.any(String),
        clientName: "Claude",
        createdAt: created2,
        lastUsedAt: null,
      },
      {
        id: expect.any(String),
        clientName: "Claude",
        createdAt: created1,
        lastUsedAt: null,
      },
    ]);
    touchOAuthGrant(db, grants[1]!.id, "2026-11-09T00:00:00.000Z");
    const again = (await (
      await app.request("/api/oauth/grants", {
        headers: { cookie: aliceCookie },
      })
    ).json()) as { grants: GrantBody[] };
    expect(again.grants[1]!.lastUsedAt).toBe("2026-11-09T00:00:00.000Z");
  });

  it("revokes the caller's grant so its access token stops working", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const { grants } = (await (
      await app.request("/api/oauth/grants", {
        headers: { cookie: aliceCookie },
      })
    ).json()) as { grants: GrantBody[] };
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(200);

    const res = await app.request(`/api/oauth/grants/${grants[0]!.id}`, {
      method: "DELETE",
      headers: { cookie: aliceCookie },
    });
    expect(res.status).toBe(204);
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(401);
  });

  it("404s another user's grant or an unknown id without revoking", async () => {
    const { app, db, clock } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const { grants } = (await (
      await app.request("/api/oauth/grants", {
        headers: { cookie: aliceCookie },
      })
    ).json()) as { grants: GrantBody[] };
    for (const id of [grants[0]!.id, "unknown"]) {
      const res = await app.request(`/api/oauth/grants/${id}`, {
        method: "DELETE",
        headers: { cookie: bobCookie },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: expect.any(String),
        code: "not_found",
      });
    }
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(200);
  });

  it("removing the user removes their grants and tokens", async () => {
    const { app, db, clock, aliceId } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const bobTokens: TokenBody = (await connect(app, bobCookie)).tokens;
    deleteUser(db, aliceId);
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM oauth_grants WHERE userId = ?")
        .get(aliceId),
    ).toEqual({ n: 0 });
    for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"]) {
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
        n: 1,
      });
    }
    expect(await bearerStatus(db, clock, tokens.access_token)).toBe(401);
    expect(await bearerStatus(db, clock, bobTokens.access_token)).toBe(200);
  });
});
