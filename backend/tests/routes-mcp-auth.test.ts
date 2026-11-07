/**
 * End-to-end wiring of the MCP endpoint in the real app: `/mcp` is only
 * reachable with an access token issued by the OAuth flow, runs the
 * tools as that token's user, and stops working the moment the grant is
 * revoked or the token expires (refresh issues a working one).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { createShare } from "../src/db/repository";
import type { ServerEnv } from "../src/server";
import {
  aliceCookie,
  bobCookie,
  connect,
  createOAuthApp,
  tokenRequest,
} from "./oauth-test-helpers";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** The JSON-RPC response fields these tests read. */
interface RpcBody {
  result?: {
    tools?: { name: string }[];
    structuredContent?: { spaces?: { space: string; sharedBy?: string }[] };
  };
}

/**
 * POST one JSON-RPC request to /mcp.
 *
 * @param app - the app under test
 * @param method - JSON-RPC method
 * @param params - JSON-RPC params
 * @param token - bearer access token, if any
 * @returns the raw response
 */
function rpc(
  app: Hono<ServerEnv>,
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}

/**
 * List the space ids the token's user sees through `list_spaces`.
 *
 * @param app - the app under test
 * @param token - bearer access token
 * @returns the space ids
 */
async function spaceIds(app: Hono<ServerEnv>, token: string) {
  const res = await rpc(
    app,
    "tools/call",
    { name: "list_spaces", arguments: {} },
    token,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as RpcBody;
  return (body.result?.structuredContent?.spaces ?? []).map((s) => s.space);
}

describe("/mcp behind OAuth", () => {
  test("without a token it is 401 with the resource metadata challenge", async () => {
    const { app } = createOAuthApp(databases);
    const res = await rpc(app, "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("an issued access token lists the eight tools", async () => {
    const { app } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const res = await rpc(app, "tools/list", {}, tokens.access_token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcBody;
    expect((body.result?.tools ?? []).map((t) => t.name).sort()).toEqual([
      "create_folder",
      "create_share_link",
      "list_folder",
      "list_spaces",
      "move_file",
      "read_file",
      "search",
      "write_file",
    ]);
  });

  test("tools run as the token's user, seeing only their shares", async () => {
    const { app, db, aliceId, bobId } = createOAuthApp(databases);
    const share = createShare(db, {
      ownerUserId: aliceId,
      recipientUserId: bobId,
      folder: "projects",
    });
    const alice = await connect(app, aliceCookie);
    const bob = await connect(app, bobCookie);
    expect(await spaceIds(app, alice.tokens.access_token)).toEqual(["own"]);
    expect(await spaceIds(app, bob.tokens.access_token)).toEqual([
      "own",
      `shared:${share.id}`,
    ]);
  });

  test("revoking the connection in Settings cuts the token off", async () => {
    const { app } = createOAuthApp(databases);
    const { tokens } = await connect(app);
    const list = await app.request("/api/oauth/grants", {
      headers: { Cookie: aliceCookie },
    });
    const { grants } = (await list.json()) as { grants: { id: string }[] };
    expect(grants).toHaveLength(1);
    const del = await app.request(`/api/oauth/grants/${grants[0]?.id}`, {
      method: "DELETE",
      headers: { Cookie: aliceCookie },
    });
    expect(del.status).toBe(204);

    const res = await rpc(app, "tools/list", {}, tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  test("an expired access token is refused and a refreshed one works", async () => {
    const { app, clock } = createOAuthApp(databases);
    const { clientId, tokens } = await connect(app);
    clock.now += 60 * 60 * 1000 + 1;
    expect((await rpc(app, "ping", {}, tokens.access_token)).status).toBe(401);

    const refreshed = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    expect((await rpc(app, "ping", {}, next.access_token)).status).toBe(200);
  });
});
