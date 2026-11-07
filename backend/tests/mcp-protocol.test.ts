/**
 * Protocol tests for the MCP endpoint (`POST /mcp`): stateless
 * Streamable HTTP carrying single JSON-RPC 2.0 messages, protocol
 * version negotiation, the DNS-rebinding Origin guard and method
 * handling (initialize, ping, tools/list).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ORIGIN,
  closeMcpTestDatabases,
  createMcpTestEnv,
  postRaw,
  rpc,
} from "./mcp-test-helpers";
import type { RpcResponse } from "./mcp-test-helpers";
import { MCP_MAX_BODY_BYTES } from "../src/routes/mcp";
import { SUPPORTED_PROTOCOL_VERSIONS, serverInfo } from "../src/mcp/protocol";

/** The SPA's static assets, served from the app origin. */
const publicDir = fileURLToPath(
  new URL("../../frontend/public/", import.meta.url),
);

/** The icons `initialize` advertises for the test origin. */
const EXPECTED_ICONS = [
  {
    src: `${ORIGIN}/icon-512.png`,
    mimeType: "image/png",
    sizes: ["512x512"],
  },
  {
    src: `${ORIGIN}/icon-192.png`,
    mimeType: "image/png",
    sizes: ["192x192"],
  },
  {
    src: `${ORIGIN}/favicon.svg`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];

afterEach(closeMcpTestDatabases);

describe("POST /mcp transport", () => {
  it("requires the bearer middleware to pass", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(
      app,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      { user: null },
    );
    expect(res.status).toBe(401);
  });

  it("refuses a body over the limit with 413 and a JSON-RPC error", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(app, "x".repeat(MCP_MAX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    const body = (await res.json()) as RpcResponse;
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null });
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toContain("too large");
  });

  it("authenticates before applying the body limit", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(app, "x".repeat(MCP_MAX_BODY_BYTES + 1), {
      user: null,
    });
    expect(res.status).toBe(401);
  });

  it("accepts a body that fills a maximal JSON-escaped write_file call", async () => {
    const { app } = createMcpTestEnv();
    // 10 MiB of control characters, each escaped to six bytes ("\u0001").
    const content = "\u0001".repeat(10 * 1024 * 1024);
    const res = await postRaw(
      app,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_file", arguments: { path: "a.txt", content } },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.result).toBeDefined();
  });

  it("answers malformed JSON with a -32700 parse error", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(app, "{not json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcResponse;
    expect(body).toMatchObject({ jsonrpc: "2.0", id: null });
    expect(body.error?.code).toBe(-32700);
  });

  it("refuses a JSON array (batch) with -32600", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(
      app,
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32600);
  });

  it("refuses a message that is not JSON-RPC 2.0 with -32600", async () => {
    const { app } = createMcpTestEnv();
    for (const message of [
      { id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, method: 7 },
      { jsonrpc: "2.0", id: { nested: true }, method: "ping" },
      "ping",
      null,
    ]) {
      const res = await postRaw(app, JSON.stringify(message));
      expect(res.status).toBe(400);
      expect(((await res.json()) as RpcResponse).error?.code).toBe(-32600);
    }
  });

  it("answers an unknown method with -32601 and echoes the id", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(
      app,
      JSON.stringify({ jsonrpc: "2.0", id: "abc", method: "resources/list" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as RpcResponse;
    expect(body.id).toBe("abc");
    expect(body.error?.code).toBe(-32601);
  });

  it("accepts notifications and responses with 202 and no body", async () => {
    const { app } = createMcpTestEnv();
    for (const message of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
      { jsonrpc: "2.0", id: 5, result: {} },
      { jsonrpc: "2.0", id: 5, error: { code: -1, message: "x" } },
    ]) {
      const res = await postRaw(app, JSON.stringify(message));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    }
  });

  it("refuses an unsupported MCP-Protocol-Version header with 400", async () => {
    const { app } = createMcpTestEnv();
    const res = await postRaw(
      app,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      { headers: { "mcp-protocol-version": "1999-01-01" } },
    );
    expect(res.status).toBe(400);
  });

  it("accepts every supported MCP-Protocol-Version header", async () => {
    const { app } = createMcpTestEnv();
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const res = await postRaw(
        app,
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        { headers: { "mcp-protocol-version": version } },
      );
      expect(res.status).toBe(200);
    }
  });

  it("refuses a foreign Origin with 403 and allows the app origin", async () => {
    const { app } = createMcpTestEnv();
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const bad = await postRaw(app, ping, {
      headers: { origin: "https://evil.example" },
    });
    expect(bad.status).toBe(403);
    const good = await postRaw(app, ping, { headers: { origin: ORIGIN } });
    expect(good.status).toBe(200);
  });

  it("answers GET and DELETE with 405 and Allow: POST", async () => {
    const { app } = createMcpTestEnv();
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", {
        method,
        headers: { "x-test-user": "alice" },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("MCP methods", () => {
  it("initialize echoes a supported requested version", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "jivedrive", version: "0.1.0" },
      capabilities: { tools: {} },
    });
    expect(typeof res.result?.instructions).toBe("string");
  });

  it("initialize answers 2025-06-18 for an unsupported version", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "initialize", {
      protocolVersion: "2030-01-01",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.result?.protocolVersion).toBe("2025-06-18");
  });

  it("initialize without a protocolVersion is invalid params", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "initialize", {});
    expect(res.error?.code).toBe(-32602);
  });

  it("initialize advertises the app's icons for every supported version", async () => {
    const { app } = createMcpTestEnv();
    for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = await rpc(app, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(res.result?.serverInfo).toEqual({
        name: "jivedrive",
        version: "0.1.0",
        icons: EXPECTED_ICONS,
      });
    }
  });

  it("serverInfo builds icon URLs on the origin it is given", () => {
    expect(
      serverInfo("https://drive.grimes.id.au").icons.map((icon) => icon.src),
    ).toEqual([
      "https://drive.grimes.id.au/icon-512.png",
      "https://drive.grimes.id.au/icon-192.png",
      "https://drive.grimes.id.au/favicon.svg",
    ]);
  });

  it("every advertised icon is a static asset matching its declared type and size", () => {
    for (const icon of serverInfo(ORIGIN).icons) {
      const bytes = readFileSync(
        publicDir + new URL(icon.src).pathname.slice(1),
      );
      if (icon.mimeType === "image/png") {
        // PNG signature, then the IHDR chunk's big-endian width and height.
        expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
        const size = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
        expect(icon.sizes).toEqual([size]);
      } else {
        expect(icon.mimeType).toBe("image/svg+xml");
        expect(bytes.toString("utf8")).toStartWith("<svg");
        expect(icon.sizes).toEqual(["any"]);
      }
    }
  });

  it("ping returns an empty result", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "ping");
    expect(res.result).toEqual({});
  });

  it("tools/list lists exactly the eight tools with schemas and annotations", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "tools/list");
    const tools = res.result?.tools as Array<{
      name: string;
      description: string;
      inputSchema: { type: string };
      annotations: Record<string, boolean>;
    }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_folder",
      "create_share_link",
      "list_folder",
      "list_spaces",
      "move_file",
      "read_file",
      "search",
      "write_file",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("read_file")?.annotations.readOnlyHint).toBe(true);
    expect(byName.get("write_file")?.annotations.readOnlyHint).toBe(false);
    expect(byName.get("write_file")?.annotations.destructiveHint).toBe(true);
    expect(byName.get("create_share_link")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("tools/call with an unknown tool is invalid params", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "tools/call", { name: "delete_everything" });
    expect(res.error?.code).toBe(-32602);
  });

  it("tools/call with non-object arguments is invalid params", async () => {
    const { app } = createMcpTestEnv();
    const res = await rpc(app, "tools/call", {
      name: "list_spaces",
      arguments: "nope",
    });
    expect(res.error?.code).toBe(-32602);
    const missing = await rpc(app, "tools/call", {});
    expect(missing.error?.code).toBe(-32602);
  });
});
