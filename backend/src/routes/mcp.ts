/**
 * The remote MCP endpoint, mounted at `/mcp`: stateless Streamable HTTP
 * carrying one JSON-RPC 2.0 message per `POST` with `application/json`
 * responses (no SSE, no sessions). Requests are authenticated by the
 * OAuth bearer middleware and run the drive tools for the token's user
 * (`mcp/tools.ts`), under the same scope rules as `/api/files`
 * (constitution IV).
 *
 * Transport rules: an `Origin` header other than the app's own origin is
 * refused with 403 (DNS-rebinding guard); an unsupported
 * `MCP-Protocol-Version` header with 400; notifications and responses
 * are acknowledged with 202 and no body; malformed messages get a
 * JSON-RPC error with HTTP 400; `GET` and `DELETE` answer 405 (no SSE
 * stream, no sessions to end).
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "../config";
import type { ServerEnv } from "../server";
import {
  RPC_ERRORS,
  dispatchRequest,
  isSupportedVersion,
  parseMessage,
  rpcError,
} from "../mcp/protocol";
import { SERVER_INSTRUCTIONS, TOOL_DEFINITIONS, callTool } from "../mcp/tools";

/**
 * Maximum `POST /mcp` body size in bytes (64 MiB). The largest legitimate
 * message is a `write_file` call carrying 10 MiB of UTF-8 content, and
 * JSON escaping can inflate that up to 6x (each control character becomes
 * `\u00XX`), so 64 MiB leaves headroom for a maximal call plus its
 * envelope. It only bounds memory: `write_file`'s own 10 MiB check is the
 * real content limit.
 */
export const MCP_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Dependencies for {@link mcpRoutes}. */
export interface McpRouteDeps {
  config: AppConfig;
  db: Database;
  s3Client: S3Client;
  /** Validates the OAuth access token and sets `c.get("user")`. */
  requireBearer: MiddlewareHandler<ServerEnv>;
}

/**
 * Answer a method the endpoint does not serve.
 *
 * @param c - Hono context
 * @returns 405 with `Allow: POST`
 */
function methodNotAllowed(c: Context<ServerEnv>): Response {
  c.header("Allow", "POST");
  return c.json(
    {
      error: "Method not allowed; send JSON-RPC with POST",
      code: "method_not_allowed",
    },
    405,
  );
}

/**
 * Create the MCP route module (mounted by the server at `/mcp`).
 *
 * @param deps - configuration, database, S3 client and bearer middleware
 * @returns a Hono app serving `POST /`, with 405 for `GET`/`DELETE`
 */
export function mcpRoutes(deps: McpRouteDeps): Hono<ServerEnv> {
  const { config, db, s3Client, requireBearer } = deps;
  const origin = config.webauthn.origin;
  const app = new Hono<ServerEnv>();

  // DNS-rebinding guard: browsers always send Origin on cross-origin
  // requests; a foreign one must never reach the tools.
  app.use("*", async (c, next) => {
    const requestOrigin = c.req.header("origin");
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      return c.json({ error: "Origin not allowed", code: "forbidden" }, 403);
    }
    await next();
  });

  app.get("/", methodNotAllowed);
  app.delete("/", methodNotAllowed);

  app.post(
    "/",
    requireBearer,
    // After authentication, so an unauthenticated request still gets 401.
    bodyLimit({
      maxSize: MCP_MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          rpcError(
            null,
            RPC_ERRORS.invalidRequest,
            `Request body too large (limit ${MCP_MAX_BODY_BYTES} bytes)`,
          ),
          413,
        ),
    }),
    async (c) => {
      const version = c.req.header("mcp-protocol-version");
      if (version !== undefined && !isSupportedVersion(version)) {
        return c.json(
          {
            error: `Unsupported MCP-Protocol-Version: ${version}`,
            code: "unsupported_protocol_version",
          },
          400,
        );
      }
      const message = parseMessage(await c.req.text());
      if (message.kind === "invalid") {
        // Errors to well-formed requests (e.g. bad params) keep the
        // request's id and are ordinary JSON-RPC responses (200); parse
        // and envelope errors carry a null id and are HTTP 400.
        return c.json(
          message.response,
          message.response.id === null ? 400 : 200,
        );
      }
      if (message.kind === "accepted") return c.body(null, 202);

      const ctx = { db, s3Client, config, user: c.get("user") };
      const response = await dispatchRequest(message, {
        tools: TOOL_DEFINITIONS,
        instructions: SERVER_INSTRUCTIONS,
        callTool: (name, args) => callTool(ctx, name, args),
      });
      return c.json(response, 200);
    },
  );

  return app;
}
