/**
 * JSON-RPC 2.0 message handling for the MCP endpoint (stateless
 * Streamable HTTP, one message per POST): parsing and classifying an
 * incoming body, protocol version negotiation, and method dispatch for
 * `initialize`, `ping`, `tools/list` and `tools/call`. Transport concerns
 * (HTTP status, headers, auth) live in `routes/mcp.ts`; tool behaviour
 * in `mcp/tools.ts`.
 */

/** Protocol versions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The version answered when a client requests an unsupported one. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC error codes used by this server. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** A JSON-RPC request id. */
export type RpcId = string | number;

/** A JSON-RPC response message. */
export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: Record<string, unknown> }
  | {
      jsonrpc: "2.0";
      id: RpcId | null;
      error: { code: number; message: string };
    };

/** A classified incoming message. */
export type IncomingMessage =
  | {
      kind: "request";
      id: RpcId;
      method: string;
      params: Record<string, unknown>;
    }
  /** Notifications and client responses: accepted, never answered. */
  | { kind: "accepted" }
  /** Malformed: answered with this error response. */
  | { kind: "invalid"; response: RpcResponse };

/**
 * Build a JSON-RPC error response.
 *
 * @param id - request id, or null when it could not be determined
 * @param code - JSON-RPC error code
 * @param message - human-readable message
 * @returns the error response
 */
export function rpcError(
  id: RpcId | null,
  code: number,
  message: string,
): RpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Whether a value is a plain (non-array, non-null) object.
 *
 * @param value - any value
 * @returns true for plain objects
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and classify one HTTP body as a single JSON-RPC 2.0 message.
 *
 * Invalid JSON → -32700. A JSON array (batch, removed from MCP in
 * 2025-06-18) or anything that is not a JSON-RPC 2.0 object → -32600.
 * Requests need a string or number id and a string method; params, when
 * present, must be an object. Notifications (method without id) and
 * responses (id plus result or error) are accepted without an answer.
 *
 * @param text - raw request body
 * @returns the classified message
 */
export function parseMessage(text: string): IncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      kind: "invalid",
      response: rpcError(null, RPC_ERRORS.parseError, "Parse error"),
    };
  }
  const invalid = (message: string): IncomingMessage => ({
    kind: "invalid",
    response: rpcError(null, RPC_ERRORS.invalidRequest, message),
  });
  if (Array.isArray(value)) {
    return invalid("Batch requests are not supported");
  }
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return invalid("Invalid Request: expected a JSON-RPC 2.0 object");
  }
  const { id, method, params } = value;
  const hasId = "id" in value;
  if (hasId && typeof id !== "string" && typeof id !== "number") {
    return invalid("Invalid Request: id must be a string or number");
  }
  if (method === undefined) {
    if (hasId && ("result" in value || "error" in value)) {
      return { kind: "accepted" };
    }
    return invalid("Invalid Request: method is required");
  }
  if (typeof method !== "string") {
    return invalid("Invalid Request: method must be a string");
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return { kind: "accepted" };
  }
  if (params !== undefined && !isRecord(params)) {
    return {
      kind: "invalid",
      response: rpcError(
        id,
        RPC_ERRORS.invalidParams,
        "params must be an object",
      ),
    };
  }
  return { kind: "request", id, method, params: params ?? {} };
}

/**
 * Whether a protocol version is one this server speaks.
 *
 * @param version - a version string (e.g. the MCP-Protocol-Version header)
 * @returns true when supported
 */
export function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/**
 * Negotiate the protocol version for `initialize`: the client's
 * requested version when supported, otherwise the latest.
 *
 * @param requested - the client's requested version
 * @returns the version to answer with
 */
export function negotiateVersion(requested: string): string {
  return isSupportedVersion(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

/** A tool's MCP definition as listed by `tools/list`. */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}

/** An MCP tool result content item. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** An MCP `tools/call` result. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What {@link dispatchRequest} needs from the server. */
export interface DispatchContext {
  /** Every tool's definition, in listing order. */
  tools: readonly ToolDefinition[];
  /** Run one known tool with its (object) arguments. */
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  /** Server instructions returned by `initialize`. */
  instructions: string;
  /** Server identity returned by `initialize`. */
  serverInfo: ServerInfo;
}

/** An icon for the server (the MCP 2025-11-25 `Icon` shape). */
export interface ServerIcon {
  src: string;
  mimeType: string;
  sizes: string[];
}

/** Server identity reported by `initialize`. */
export interface ServerInfo {
  name: string;
  version: string;
  icons: ServerIcon[];
}

/**
 * The SPA's static app icons (`frontend/public/`), PNG first because
 * every icon-rendering client must support PNG, SVG last as an extra.
 */
const ICONS = [
  { path: "/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  { path: "/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
  { path: "/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
] as const;

/**
 * Build the server identity for `initialize`. `icons` is defined by MCP
 * 2025-11-25 but sent for every negotiated version: older clients
 * ignore it. Icon URLs are absolute on the app's own origin, the same
 * origin as `/mcp`, as the spec advises.
 *
 * @param origin - the app's origin, e.g. "https://drive.example.com"
 * @returns name, version and icons
 */
export function serverInfo(origin: string): ServerInfo {
  return {
    name: "jivedrive",
    version: "0.1.0",
    icons: ICONS.map(({ path, mimeType, sizes }) => ({
      src: new URL(path, origin).href,
      mimeType,
      sizes: [...sizes],
    })),
  };
}

/**
 * Answer one JSON-RPC request.
 *
 * @param request - the classified request
 * @param ctx - tools, server instructions and server identity
 * @returns the response to send
 */
export async function dispatchRequest(
  request: { id: RpcId; method: string; params: Record<string, unknown> },
  ctx: DispatchContext,
): Promise<RpcResponse> {
  const { id, method, params } = request;
  const ok = (result: Record<string, unknown>): RpcResponse => ({
    jsonrpc: "2.0",
    id,
    result,
  });
  switch (method) {
    case "initialize": {
      if (typeof params.protocolVersion !== "string") {
        return rpcError(
          id,
          RPC_ERRORS.invalidParams,
          "protocolVersion is required",
        );
      }
      return ok({
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: ctx.serverInfo,
        instructions: ctx.instructions,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: ctx.tools });
    case "tools/call": {
      const { name, arguments: args } = params;
      if (typeof name !== "string" || !ctx.tools.some((t) => t.name === name)) {
        return rpcError(
          id,
          RPC_ERRORS.invalidParams,
          `Unknown tool: ${String(name)}`,
        );
      }
      if (args !== undefined && !isRecord(args)) {
        return rpcError(
          id,
          RPC_ERRORS.invalidParams,
          "arguments must be an object",
        );
      }
      const result = await ctx.callTool(name, args ?? {});
      return ok({ ...result });
    }
    default:
      return rpcError(
        id,
        RPC_ERRORS.methodNotFound,
        `Method not found: ${method}`,
      );
  }
}
