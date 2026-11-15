import { expect, test } from "@playwright/test";
import type {
  APIRequestContext,
  BrowserContext,
  Page,
  TestInfo,
} from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/** Where the fake MCP client wants the authorization response sent. */
const REDIRECT_URI = "http://127.0.0.1:8976/callback";

/** The MCP resource URL of the e2e server. */
const RESOURCE = "http://localhost:5173/mcp";

/** A registered fake MCP client plus one PKCE pair for its authorization. */
interface FakeClient {
  clientId: string;
  clientName: string;
  verifier: string;
  challenge: string;
}

/**
 * A client name unique to this test attempt (retry-safe; the suite runs
 * fullyParallel against one server, so names must not collide).
 *
 * @param base - readable base name
 * @param testInfo - the running test
 * @returns the unique name
 */
function clientName(base: string, testInfo: TestInfo): string {
  return `${base}-r${testInfo.retry}-${Date.now().toString(36)}`;
}

/**
 * Register a public client by dynamic client registration, as Claude does
 * on first connection, and mint a PKCE verifier/challenge pair.
 *
 * @param request - API request context
 * @param name - the client name shown on the consent page
 * @returns the registered client and its PKCE pair
 */
async function registerClient(
  request: APIRequestContext,
  name: string,
): Promise<FakeClient> {
  const res = await request.post("/oauth/register", {
    data: { client_name: name, redirect_uris: [REDIRECT_URI] },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { clientId: body.client_id, clientName: name, verifier, challenge };
}

/**
 * Sign in as mia via her pre-seeded session (e2eServer.ts) and open the
 * authorization URL for the client, landing on the SPA consent page.
 * The redirect target is stubbed so the browser can "arrive" there.
 *
 * @param page - the page
 * @param context - the browser context
 * @param client - the registered client
 * @param state - the opaque state value to round-trip
 */
async function openConsent(
  page: Page,
  context: BrowserContext,
  client: FakeClient,
  state: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "mcp-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.route("http://127.0.0.1:8976/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "done" }),
  );
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: client.challenge,
    code_challenge_method: "S256",
    state,
    resource: RESOURCE,
    scope: "drive",
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page).toHaveURL(/\/authorize\?request=/);
  await expectSignedInAs(page, "mia");
  await expect(page.getByText(client.clientName).first()).toBeVisible();
}

/** The result of one MCP `tools/call`. */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

/** The JSON-RPC response fields these tests read. */
interface McpResponse {
  result?: {
    serverInfo?: {
      name: string;
      icons?: { src: string; mimeType: string; sizes: string[] }[];
    };
    tools?: { name: string }[];
  } & Partial<ToolResult>;
  error?: { code: number; message: string };
}

/**
 * Call one MCP JSON-RPC method with a bearer token.
 *
 * @param request - API request context
 * @param token - the access token
 * @param method - JSON-RPC method
 * @param params - JSON-RPC params
 * @param protocolVersion - the `MCP-Protocol-Version` header to send
 * @returns the HTTP status and parsed body (null for an empty body)
 */
async function mcp(
  request: APIRequestContext,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  protocolVersion = "2025-06-18",
): Promise<{ status: number; body: McpResponse | null }> {
  const res = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
    },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  const text = await res.text();
  // The server under test produced this JSON; the assertions below check
  // the fields they read.
  const body: McpResponse | null = text ? JSON.parse(text) : null;
  return { status: res.status(), body };
}

/**
 * Call one MCP tool and return its result object.
 *
 * @param request - API request context
 * @param token - the access token
 * @param name - tool name
 * @param args - tool arguments
 * @returns the tools/call result
 */
async function callTool(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { status, body } = await mcp(request, token, "tools/call", {
    name,
    arguments: args,
  });
  expect(status).toBe(200);
  expect(body?.result?.content).toBeDefined();
  return {
    isError: body?.result?.isError,
    content: body?.result?.content ?? [],
    structuredContent: body?.result?.structuredContent,
  };
}

test("an unauthenticated MCP call points the client at OAuth discovery", async ({
  request,
}) => {
  const res = await request.post("/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  expect(res.status()).toBe(401);
  expect(res.headers()["www-authenticate"]).toContain(
    'resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource/mcp"',
  );

  const resource = await request.get(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(await resource.json()).toMatchObject({
    resource: RESOURCE,
    authorization_servers: ["http://localhost:5173"],
  });
  const server = await request.get("/.well-known/oauth-authorization-server");
  expect(await server.json()).toMatchObject({
    issuer: "http://localhost:5173",
    registration_endpoint: "http://localhost:5173/oauth/register",
    code_challenge_methods_supported: ["S256"],
  });
});

test("a user connects an MCP client, it uses the drive, and revoking cuts it off", async ({
  page,
  context,
  request,
}, testInfo) => {
  const client = await registerClient(
    request,
    clientName("Claude e2e", testInfo),
  );
  await openConsent(page, context, client, "state-allow");
  await expect(
    page.getByText("Create public share links to files", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("It cannot delete files.", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:8976\/callback/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe("state-allow");
  expect(callback.searchParams.get("iss")).toBe("http://localhost:5173");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: client.verifier,
      resource: RESOURCE,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
  };

  // A client newer than the server (Hermes) sends its own version in both
  // the header and the body; the server answers with one it speaks, which
  // the client then sends on later requests.
  const init = await mcp(
    request,
    tokens.access_token,
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    },
    "2025-11-25",
  );
  expect(init.status).toBe(200);
  expect(init.body).toMatchObject({
    result: {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "jivedrive" },
    },
  });
  // The advertised icons are served, unauthenticated, from the app origin.
  const icons = init.body?.result?.serverInfo?.icons ?? [];
  expect(icons.map((icon) => icon.src)).toEqual([
    "http://localhost:5173/icon-512.png",
    "http://localhost:5173/icon-192.png",
    "http://localhost:5173/favicon.svg",
  ]);
  for (const icon of icons) {
    const iconRes = await request.get(icon.src);
    expect(iconRes.status()).toBe(200);
    expect(iconRes.headers()["content-type"]).toContain(icon.mimeType);
  }

  const list = await mcp(request, tokens.access_token, "tools/list");
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  expect(names.sort()).toEqual([
    "create_folder",
    "create_share_link",
    "list_folder",
    "list_spaces",
    "move_file",
    "read_file",
    "search",
    "write_file",
  ]);

  const folder = await callTool(request, tokens.access_token, "list_folder", {
    path: "notes",
  });
  expect(folder.isError).toBeFalsy();
  expect(JSON.stringify(folder.structuredContent)).toContain("hello.txt");

  const read = await callTool(request, tokens.access_token, "read_file", {
    path: "notes/hello.txt",
  });
  expect(read.content[0].text).toContain("hello from mia");

  // A per-attempt file name keeps retries from clashing with an earlier
  // attempt's write (overwrite defaults to false).
  const written = `notes/from-claude-r${testInfo.retry}.txt`;
  const write = await callTool(request, tokens.access_token, "write_file", {
    path: written,
    content: "written by the assistant",
  });
  expect(write.isError).toBeFalsy();
  const clash = await callTool(request, tokens.access_token, "write_file", {
    path: written,
    content: "again",
  });
  expect(clash.isError).toBe(true);

  // A share link created by the assistant opens anonymously (the request
  // fixture carries no session cookie) and serves the file's bytes.
  const link = await callTool(
    request,
    tokens.access_token,
    "create_share_link",
    { path: "notes/hello.txt", expiresIn: "1h" },
  );
  expect(link.isError).toBeFalsy();
  const url = (link.structuredContent as { url: string }).url;
  expect(url).toMatch(/^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/);
  const opened = await request.get(url);
  expect(opened.status()).toBe(200);
  expect(await opened.text()).toContain("hello from mia");

  // A binary file written as base64 is stored byte for byte with a type
  // guessed from its extension, so its share link serves it as an image.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const pngPath = `notes/pixel-r${testInfo.retry}.png`;
  const binary = await callTool(request, tokens.access_token, "write_file", {
    path: pngPath,
    content: png.toString("base64"),
    encoding: "base64",
  });
  expect(binary.isError).toBeFalsy();
  const pngLink = await callTool(
    request,
    tokens.access_token,
    "create_share_link",
    { path: pngPath, expiresIn: "1h" },
  );
  const pngOpened = await request.get(
    (pngLink.structuredContent as { url: string }).url,
  );
  expect(pngOpened.status()).toBe(200);
  expect(pngOpened.headers()["content-type"]).toBe("image/png");
  expect(Buffer.from(await pngOpened.body())).toEqual(png);

  // The written file is visible in the web listing.
  await page.goto("/files?prefix=notes%2F");
  await expect(
    page.getByText(`from-claude-r${testInfo.retry}.txt`),
  ).toBeVisible();

  // Settings lists the connection with a last-used time; revoking it
  // makes the token stop working immediately.
  await page.goto("/settings");
  const row = page
    .getByRole("list", { name: "Connected apps" })
    .getByRole("listitem")
    .filter({ hasText: client.clientName });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Last used Never");
  await row
    .getByRole("button", { name: `Revoke ${client.clientName}` })
    .click();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status").first()).toBeVisible();

  const after = await mcp(request, tokens.access_token, "tools/list");
  expect(after.status).toBe(401);
  const refresh = await request.post("/oauth/token", {
    form: {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.clientId,
    },
  });
  expect(refresh.status()).toBe(400);
});

test("denying consent returns access_denied to the client", async ({
  page,
  context,
  request,
}, testInfo) => {
  const client = await registerClient(
    request,
    clientName("Deny e2e", testInfo),
  );
  await openConsent(page, context, client, "state-deny");
  await page.getByRole("button", { name: "Deny" }).click();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:8976\/callback/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("error")).toBe("access_denied");
  expect(callback.searchParams.get("state")).toBe("state-deny");
  expect(callback.searchParams.get("code")).toBeNull();
});

test("the consent page fits a mobile viewport", async ({
  page,
  context,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const client = await registerClient(
    request,
    clientName(
      "A very long connector name for a narrow phone screen",
      testInfo,
    ),
  );
  await openConsent(page, context, client, "state-mobile");
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
