import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import type { User } from "../src/api/client";
import { AuthorizePage } from "../src/pages/Authorize";
import { SignIn } from "../src/pages/SignIn";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn().mockResolvedValue({ id: "cred-1" }),
}));

/**
 * Build a JSON response for the fetch stub.
 *
 * @param body - payload
 * @param status - HTTP status
 * @returns a Response carrying the JSON body
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The signed-in user. */
const alice: User = {
  id: "user-1",
  username: "alice",
  bucket: "jivedrive-prod",
  prefix: "users/alice/",
  isAdmin: false,
};

/** A pending authorization request as returned by the API. */
const pendingRequest = {
  id: "req-1",
  clientName: "Claude",
  redirectHost: "claude.ai",
  expiresAt: "2026-11-08T10:10:00.000Z",
};

/** The expired-request message. */
const EXPIRED =
  "This authorization request has expired or was already used. Return to the app and try connecting again.";

/** A dynamic route handler, for deferred responses and network errors. */
type RouteHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Stub global fetch. Routes are keyed by "METHOD url"; a route is either a
 * handler or a `[body, status]` pair served fresh on every call.
 *
 * @param routes - the stubbed routes
 * @returns the fetch mock for assertions
 */
function stubApi(
  routes: Record<string, RouteHandler | [unknown, number]>,
): Mock {
  const fetchMock = vi
    .fn()
    .mockImplementation(
      (url: string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? "GET";
        const route = routes[`${method} ${url}`];
        if (!route) {
          return Promise.reject(
            new Error(`Unhandled request: ${method} ${url}`),
          );
        }
        if (typeof route === "function") {
          try {
            return Promise.resolve(route(url, init));
          } catch (err) {
            return Promise.reject(err);
          }
        }
        return Promise.resolve(jsonResponse(route[0], route[1]));
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** Renders the current location so tests can assert navigation. */
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

/** Props of {@link SessionHarness}. */
interface SessionHarnessProps {
  initialUser: User | null;
  loading?: boolean;
  children: ReactNode;
}

/**
 * A stateful session fixture: `refresh` signs alice in, as a successful
 * passkey sign-in followed by /auth/me would.
 */
function SessionHarness({
  initialUser,
  loading = false,
  children,
}: SessionHarnessProps) {
  const [user, setUser] = useState<User | null>(initialUser);
  return (
    <SessionContext.Provider
      value={{
        user,
        loading,
        refresh: async () => setUser(alice),
        signOut: async () => setUser(null),
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Render the app routes the consent flow touches at a starting URL.
 *
 * @param url - the initial URL
 * @param user - the signed-in user, or null when signed out
 * @param loading - whether the session is still loading
 * @returns the container element
 */
async function renderAt(
  url: string,
  user: User | null = alice,
  loading = false,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <SessionHarness initialUser={user} loading={loading}>
          <Routes>
            <Route path="/" element={<SignIn />} />
            <Route path="/authorize" element={<AuthorizePage />} />
            <Route path="/files" element={<p>Files page</p>} />
          </Routes>
          <LocationProbe />
        </SessionHarness>
      </MemoryRouter>,
    );
  });
  return container;
}

/**
 * Find a button by its visible text.
 *
 * @param root - the element to search
 * @param name - the exact trimmed text
 * @returns the button, or undefined
 */
function button(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === name,
  );
}

/**
 * Click a button inside act.
 *
 * @param target - the button
 */
async function click(target: HTMLButtonElement | undefined): Promise<void> {
  if (!target) throw new Error("button not found");
  await act(async () => {
    target.click();
  });
}

/** The current router location rendered by the probe. */
function currentLocation(container: HTMLElement): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? "";
}

let assign: Mock;

beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AuthorizePage", () => {
  it("shows a loading state while the request loads", async () => {
    const { promise } = Promise.withResolvers<Response>();
    stubApi({ "GET /api/oauth/requests/req-1": () => promise });
    const container = await renderAt("/authorize?request=req-1");

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading",
    );
    expect(button(container, "Allow")).toBeUndefined();
    expect(button(container, "Deny")).toBeUndefined();
  });

  it("names the client, its redirect host, the user and what it can and cannot do", async () => {
    stubApi({ "GET /api/oauth/requests/req-1": [pendingRequest, 200] });
    const container = await renderAt("/authorize?request=req-1");

    const text = container.textContent ?? "";
    expect(text).toContain("Claude");
    expect(text).toContain("wants to access your JiveDrive");
    expect(text).toContain("claude.ai");
    expect(text).toContain("alice");
    const items = Array.from(container.querySelectorAll("li")).map((li) =>
      li.textContent?.trim(),
    );
    expect(items).toEqual([
      "List, search and read files",
      "Create folders",
      "Write new files, and replace existing files when asked",
      "Move files",
    ]);
    expect(text).toContain("in your drive and in folders shared with you");
    expect(text).toContain("It cannot delete files or create share links.");
    expect(button(container, "Allow")?.className).toContain("min-h-11");
    expect(button(container, "Deny")?.className).toContain("min-h-11");
  });

  it("approves, shows progress, then sends the browser to the redirect", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const fetchMock = stubApi({
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
      "POST /api/oauth/requests/req-1/approve": () => promise,
    });
    const container = await renderAt("/authorize?request=req-1");

    await click(button(container, "Allow"));
    expect(container.textContent).toContain("Connecting...");
    expect(button(container, "Deny")?.disabled).toBe(true);
    expect(assign).not.toHaveBeenCalled();

    await act(async () => {
      resolve(
        jsonResponse({ redirectTo: "https://claude.ai/cb?code=abc&state=s" }),
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/requests/req-1/approve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(assign).toHaveBeenCalledWith(
      "https://claude.ai/cb?code=abc&state=s",
    );
  });

  it("denies and sends the browser to the redirect", async () => {
    const fetchMock = stubApi({
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
      "POST /api/oauth/requests/req-1/deny": [
        { redirectTo: "https://claude.ai/cb?error=access_denied" },
        200,
      ],
    });
    const container = await renderAt("/authorize?request=req-1");

    await click(button(container, "Deny"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/requests/req-1/deny",
      expect.objectContaining({ method: "POST" }),
    );
    expect(assign).toHaveBeenCalledWith(
      "https://claude.ai/cb?error=access_denied",
    );
  });

  it("explains that an unknown or expired request cannot be used", async () => {
    stubApi({
      "GET /api/oauth/requests/req-1": [
        { error: "Not found", code: "not_found" },
        404,
      ],
    });
    const container = await renderAt("/authorize?request=req-1");

    expect(container.textContent).toContain(EXPIRED);
    expect(button(container, "Allow")).toBeUndefined();
  });

  it("explains a missing request id without calling the API", async () => {
    const fetchMock = stubApi({});
    const container = await renderAt("/authorize");

    expect(container.textContent).toContain(EXPIRED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the expired message when the request is used up before the decision", async () => {
    stubApi({
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
      "POST /api/oauth/requests/req-1/approve": [
        { error: "Not found", code: "not_found" },
        404,
      ],
    });
    const container = await renderAt("/authorize?request=req-1");

    await click(button(container, "Allow"));

    expect(container.textContent).toContain(EXPIRED);
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows an explicit error and re-enables the buttons when the server fails", async () => {
    stubApi({
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
      "POST /api/oauth/requests/req-1/approve": [
        { error: "Internal server error", code: "internal_error" },
        500,
      ],
    });
    const container = await renderAt("/authorize?request=req-1");

    await click(button(container, "Allow"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Internal server error",
    );
    expect(button(container, "Allow")?.disabled).toBe(false);
    expect(button(container, "Deny")?.disabled).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a connection error and re-enables the buttons when the network fails", async () => {
    stubApi({
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
      "POST /api/oauth/requests/req-1/deny": () => {
        throw new TypeError("fetch failed");
      },
    });
    const container = await renderAt("/authorize?request=req-1");

    await click(button(container, "Deny"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach the server",
    );
    expect(button(container, "Deny")?.disabled).toBe(false);
  });

  it("shows an error with a retry when the request fails to load", async () => {
    let calls = 0;
    stubApi({
      "GET /api/oauth/requests/req-1": () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(pendingRequest);
      },
    });
    const container = await renderAt("/authorize?request=req-1");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach the server",
    );
    await click(button(container, "Try again"));
    expect(button(container, "Allow")).toBeDefined();
  });

  it("shows the session check while the session loads", async () => {
    const fetchMock = stubApi({});
    const container = await renderAt("/authorize?request=req-1", null, true);

    expect(container.textContent).toContain("Checking session...");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in and returns to the same request", async () => {
    const fetchMock = stubApi({
      "POST /auth/login/options": [
        { requestId: "login-1", options: { challenge: "c" } },
        200,
      ],
      "POST /auth/login/verify": [{ user: alice }, 200],
      "GET /api/oauth/requests/req-1": [pendingRequest, 200],
    });
    const container = await renderAt("/authorize?request=req-1", null);

    expect(button(container, "Sign in with passkey")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(button(container, "Sign in with passkey"));

    expect(currentLocation(container)).toBe("/authorize?request=req-1");
    expect(container.textContent).toContain("wants to access your JiveDrive");
    expect(button(container, "Allow")).toBeDefined();
  });
});

describe("SignIn without a return URL", () => {
  it("still lands on /files after signing in", async () => {
    stubApi({
      "POST /auth/login/options": [
        { requestId: "login-1", options: { challenge: "c" } },
        200,
      ],
      "POST /auth/login/verify": [{ user: alice }, 200],
    });
    const container = await renderAt("/", null);

    await click(button(container, "Sign in with passkey"));

    expect(currentLocation(container)).toBe("/files");
  });
});
