import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { requireBearer } from "../src/auth/bearer";
import { getOAuthGrant } from "../src/db/repository";
import type { ServerEnv } from "../src/server";
import { config, connect, createOAuthApp } from "./oauth-test-helpers";
import type { TestClock } from "./oauth-test-helpers";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CHALLENGE =
  'Bearer resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource/mcp"';

/** A tiny protected app that echoes the signed-in username. */
function protectedApp(db: Database, clock: TestClock) {
  const app = new Hono<ServerEnv>();
  app.use(
    "*",
    requireBearer(db, config, () => clock.now),
  );
  app.get("/whoami", (c) => c.json({ username: c.get("user").username }));
  return app;
}

/** Issue tokens for alice and build the protected app over the same db. */
async function setup() {
  const oauth = createOAuthApp(databases);
  const { tokens } = await connect(oauth.app);
  return { ...oauth, tokens, guarded: protectedApp(oauth.db, oauth.clock) };
}

describe("requireBearer", () => {
  it("accepts a valid access token, sets the user and records last use", async () => {
    const { db, aliceId, tokens, guarded, clock } = await setup();
    const res = await guarded.request("/whoami", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice" });
    const grantId = (
      db.query("SELECT id FROM oauth_grants WHERE userId = ?").get(aliceId) as {
        id: string;
      }
    ).id;
    expect(getOAuthGrant(db, grantId)?.lastUsedAt).toBe(
      new Date(clock.now).toISOString(),
    );
  });

  it("accepts a case-insensitive scheme", async () => {
    const { tokens, guarded } = await setup();
    const res = await guarded.request("/whoami", {
      headers: { authorization: `bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(200);
  });

  it("401s with the bare challenge when no token is presented", async () => {
    const { guarded } = await setup();
    for (const headers of [
      {},
      { authorization: "Basic dXNlcjpwYXNz" },
    ] as Array<Record<string, string>>) {
      const res = await guarded.request("/whoami", { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(((await res.json()) as { code: string }).code).toBe(
        "unauthorized",
      );
    }
  });

  it("401s with invalid_token for an unknown token", async () => {
    const { guarded } = await setup();
    const res = await guarded.request("/whoami", {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `${CHALLENGE}, error="invalid_token"`,
    );
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "unauthorized",
    });
  });

  it("expires access tokens after one hour", async () => {
    const { tokens, guarded, clock } = await setup();
    const headers = { authorization: `Bearer ${tokens.access_token}` };
    clock.now += 3599 * 1000;
    expect((await guarded.request("/whoami", { headers })).status).toBe(200);
    clock.now += 1000;
    const res = await guarded.request("/whoami", { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `${CHALLENGE}, error="invalid_token"`,
    );
  });

  it("rejects the token once the user is deleted", async () => {
    const { db, aliceId, tokens, guarded } = await setup();
    db.query("DELETE FROM users WHERE id = ?").run(aliceId);
    const res = await guarded.request("/whoami", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(401);
  });
});
