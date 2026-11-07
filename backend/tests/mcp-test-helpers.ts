/**
 * Shared harness for the MCP endpoint tests: a fresh in-memory database
 * with seeded users, an in-memory fake S3 bucket behind a real SDK
 * client (only `send` is stubbed, following `routes-files.test.ts`),
 * and `mcpRoutes` mounted at `/mcp` behind a stub bearer middleware that
 * signs in the user named by the `x-test-user` header.
 */
import type { Database } from "bun:sqlite";
import type { S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { fileURLToPath } from "node:url";
import { migrateFromDir, openDatabase } from "../src/db/migrate";
import { createUser, getUserByUsername } from "../src/db/repository";
import type { User } from "../src/db/repository";
import { createS3Client } from "../src/s3/client";
import type { AppConfig } from "../src/config";
import type { ServerEnv } from "../src/server";
import { mcpRoutes } from "../src/routes/mcp";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** The app's origin in tests (the DNS-rebinding guard compares to it). */
export const ORIGIN = "http://localhost:5173";

/** The single bucket every seeded user lives in. */
export const BUCKET = "jivedrive-prod";

/** A config whose S3 endpoint is never contacted (send is stubbed). */
export const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  dbPath: ":memory:",
  migrationsDir,
  sessionTtlDays: 30,
  sessionIdleDays: 7,
  searchScanIntervalSeconds: 3600,
  searchIndexMaxBytes: 1024 * 1024,
  rateLimit: {
    authPerMinute: 20,
    authBurst: 10,
    filesPerMinute: 300,
    filesBurst: 100,
    shareLinksPerMinute: 60,
    shareLinksBurst: 30,
    trustProxy: false,
  },
  s3: {
    endpoint: "https://s3.gra.io.cloud.ovh.net",
    region: "gra",
    accessKeyId: "AKIAEXAMPLE123",
    secretAccessKey: "s3cr3t",
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

/** One stored object in the fake bucket. */
export interface FakeObject {
  body: Uint8Array;
  contentType?: string;
  lastModified: Date;
}

/** One S3 command sent to the fake. */
export interface CallRecord {
  name: string;
  input: Record<string, unknown>;
}

/** A seeded MCP test environment. */
export interface McpTestEnv {
  app: Hono<ServerEnv>;
  db: Database;
  store: Map<string, FakeObject>;
  calls: CallRecord[];
  alice: User;
  bob: User;
  carol: User;
}

const openDatabases: Database[] = [];

/** Close every database opened by {@link createMcpTestEnv}. */
export function closeMcpTestDatabases(): void {
  for (const db of openDatabases.splice(0)) db.close();
}

/**
 * Put an object into the fake bucket.
 *
 * @param store - the fake bucket
 * @param key - full object key
 * @param body - text or bytes
 * @param contentType - optional stored content type
 */
export function putFake(
  store: Map<string, FakeObject>,
  key: string,
  body: string | Uint8Array,
  contentType?: string,
): void {
  store.set(key, {
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    contentType,
    lastModified: new Date("2026-01-02T03:04:05.000Z"),
  });
}

/** A "NotFound"-named error as the SDK raises for HeadObject misses. */
function notFound(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/**
 * Answer one S3 command against the in-memory bucket. Listings honour
 * Prefix, Delimiter, MaxKeys and ContinuationToken (the token is the
 * numeric offset into the sorted entry list).
 */
function handle(
  store: Map<string, FakeObject>,
  name: string,
  input: Record<string, unknown>,
): unknown {
  switch (name) {
    case "ListObjectsV2Command": {
      const prefix = (input.Prefix as string | undefined) ?? "";
      const delimiter = input.Delimiter as string | undefined;
      const maxKeys = (input.MaxKeys as number | undefined) ?? 1000;
      const start = Number((input.ContinuationToken as string) ?? "0");
      const entries: Array<{ kind: "prefix" | "object"; key: string }> = [];
      const seenPrefixes = new Set<string>();
      for (const key of [...store.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if (cut !== -1) {
          const common = prefix + rest.slice(0, cut + 1);
          if (!seenPrefixes.has(common)) {
            seenPrefixes.add(common);
            entries.push({ kind: "prefix", key: common });
          }
        } else {
          entries.push({ kind: "object", key });
        }
      }
      const page = entries.slice(start, start + maxKeys);
      const truncated = start + maxKeys < entries.length;
      return {
        CommonPrefixes: page
          .filter((e) => e.kind === "prefix")
          .map((e) => ({ Prefix: e.key })),
        Contents: page
          .filter((e) => e.kind === "object")
          .map((e) => ({
            Key: e.key,
            Size: store.get(e.key)?.body.length ?? 0,
            LastModified: store.get(e.key)?.lastModified,
          })),
        IsTruncated: truncated,
        NextContinuationToken: truncated ? String(start + maxKeys) : undefined,
      };
    }
    case "HeadObjectCommand": {
      const object = store.get(input.Key as string);
      if (!object) throw notFound("NotFound");
      return {
        ContentLength: object.body.length,
        ContentType: object.contentType,
        LastModified: object.lastModified,
      };
    }
    case "GetObjectCommand": {
      const object = store.get(input.Key as string);
      if (!object) throw notFound("NoSuchKey");
      return {
        Body: { transformToByteArray: async () => object.body },
        ContentType: object.contentType,
        ContentLength: object.body.length,
      };
    }
    case "PutObjectCommand": {
      const body = input.Body;
      putFake(
        store,
        input.Key as string,
        typeof body === "string" ? body : (body as Uint8Array),
        input.ContentType as string | undefined,
      );
      return {};
    }
    case "CopyObjectCommand": {
      const source = decodeURIComponent(
        (input.CopySource as string).split("/").slice(1).join("/"),
      );
      const object = store.get(source);
      if (!object) throw notFound("NoSuchKey");
      store.set(input.Key as string, { ...object });
      return {};
    }
    case "DeleteObjectCommand": {
      store.delete(input.Key as string);
      return {};
    }
    default:
      throw new Error(`Unexpected S3 command ${name}`);
  }
}

/**
 * A stub bearer middleware: the `x-test-user` header names the signed-in
 * user; absent or unknown → 401 like the real middleware.
 *
 * @param db - database holding the users
 * @returns middleware setting `c.get("user")`
 */
function stubBearer(db: Database): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const username = c.req.header("x-test-user");
    const user = username ? getUserByUsername(db, username) : null;
    if (!user) {
      return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
    }
    c.set("user", user);
    await next();
  };
}

/**
 * Build a fresh MCP test environment: alice, bob and carol in one
 * bucket, an empty fake bucket, and `/mcp` mounted.
 *
 * @returns the environment
 */
export function createMcpTestEnv(): McpTestEnv {
  const db = openDatabase(":memory:");
  migrateFromDir(db, migrationsDir);
  openDatabases.push(db);
  const alice = createUser(db, {
    username: "alice",
    bucket: BUCKET,
    prefix: "users/alice/",
  });
  const bob = createUser(db, {
    username: "bob",
    bucket: BUCKET,
    prefix: "users/bob/",
  });
  const carol = createUser(db, {
    username: "carol",
    bucket: BUCKET,
    prefix: "users/carol/",
  });
  const store = new Map<string, FakeObject>();
  const calls: CallRecord[] = [];
  const client = createS3Client(config.s3);
  client.send = (async (command: unknown) => {
    const name = (command as { constructor: { name: string } }).constructor
      .name;
    const input = (command as { input: Record<string, unknown> }).input ?? {};
    calls.push({ name, input });
    return handle(store, name, input);
  }) as unknown as S3Client["send"];
  const app = new Hono<ServerEnv>();
  app.route(
    "/mcp",
    mcpRoutes({
      config,
      db,
      s3Client: client,
      requireBearer: stubBearer(db),
    }),
  );
  return { app, db, store, calls, alice, bob, carol };
}

/** A JSON-RPC response body. */
export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * POST a raw body to `/mcp` as a user.
 *
 * @param app - the app
 * @param body - raw request body
 * @param options - signed-in user (default alice) and extra headers
 * @returns the response
 */
export function postRaw(
  app: Hono<ServerEnv>,
  body: string,
  options: { user?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const user = options.user === undefined ? "alice" : options.user;
  return Promise.resolve(
    app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(user ? { "x-test-user": user } : {}),
        ...options.headers,
      },
      body,
    }),
  );
}

/**
 * Send one JSON-RPC request and parse the response.
 *
 * @param app - the app
 * @param method - JSON-RPC method
 * @param params - params object
 * @param user - signed-in username (default alice)
 * @returns the parsed JSON-RPC response
 */
export async function rpc(
  app: Hono<ServerEnv>,
  method: string,
  params?: Record<string, unknown>,
  user = "alice",
): Promise<RpcResponse> {
  const res = await postRaw(
    app,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    { user },
  );
  return (await res.json()) as RpcResponse;
}

/** An MCP tool result. */
export interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Call one tool and return its result (throws on a JSON-RPC error).
 *
 * @param app - the app
 * @param name - tool name
 * @param args - tool arguments
 * @param user - signed-in username (default alice)
 * @returns the tool result
 */
export async function callTool(
  app: Hono<ServerEnv>,
  name: string,
  args: Record<string, unknown> = {},
  user = "alice",
): Promise<ToolResult> {
  const response = await rpc(
    app,
    "tools/call",
    { name, arguments: args },
    user,
  );
  if (response.error) {
    throw new Error(
      `JSON-RPC error ${response.error.code}: ${response.error.message}`,
    );
  }
  return response.result as unknown as ToolResult;
}

/**
 * The text of a tool result's first content item.
 *
 * @param result - tool result
 * @returns the text ("" when absent)
 */
export function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}
