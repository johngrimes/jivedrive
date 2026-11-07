import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConnectedApps } from "../src/components/ConnectedApps";

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

/** A grant that has been used. */
const usedGrant = {
  id: "g1",
  clientName: "Claude",
  createdAt: "2026-11-01T09:30:00.000Z",
  lastUsedAt: "2026-11-07T14:05:00.000Z",
};

/** A grant that has never been used. */
const unusedGrant = {
  id: "g2",
  clientName: "Claude Desktop",
  createdAt: "2026-11-02T10:00:00.000Z",
  lastUsedAt: null,
};

/** A dynamic route handler, for deferred responses and network errors. */
type RouteHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Stub global fetch. Routes are keyed by "METHOD url"; a route is either a
 * handler or a `[body, status]` pair (null body for an empty response).
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
        if (route[0] === null) {
          return Promise.resolve(new Response(null, { status: route[1] }));
        }
        return Promise.resolve(jsonResponse(route[0], route[1]));
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * Render the section into jsdom.
 *
 * @returns the container element
 */
async function renderSection(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ConnectedApps />);
  });
  return container;
}

/**
 * Find a button by its accessible name (aria-label, else its text).
 *
 * @param root - the element to search
 * @param name - the exact accessible name
 * @returns the button, or undefined
 */
function button(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll("button")).find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
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

/** The rows of the connected apps list. */
function rows(container: HTMLElement): Element[] {
  return Array.from(
    container.querySelectorAll('[aria-label="Connected apps"] li'),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ConnectedApps", () => {
  it("shows a loading state, then the heading", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    stubApi({ "GET /api/oauth/grants": () => promise });
    const container = await renderSection();

    expect(container.textContent).toContain("Connected apps");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Loading",
    );

    await act(async () => {
      resolve(jsonResponse({ grants: [] }));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("lists each grant with its name, connected date and last use", async () => {
    stubApi({
      "GET /api/oauth/grants": [{ grants: [usedGrant, unusedGrant] }, 200],
    });
    const container = await renderSection();

    const [first, second] = rows(container);
    expect(first?.textContent).toContain("Claude");
    expect(first?.textContent).toMatch(/Connected 2026-11-0\d \d{2}:\d{2}/);
    expect(first?.textContent).toMatch(/Last used 2026-11-0\d \d{2}:\d{2}/);
    expect(second?.textContent).toContain("Claude Desktop");
    expect(second?.textContent).toContain("Last used Never");
    expect(button(container, "Revoke Claude")?.className).toContain("min-h-11");
  });

  it("explains how to connect when no apps are connected", async () => {
    stubApi({ "GET /api/oauth/grants": [{ grants: [] }, 200] });
    const container = await renderSection();

    expect(container.textContent).toContain(
      `No apps are connected. Add JiveDrive as a connector in Claude using ${window.location.origin}/mcp.`,
    );
    expect(rows(container)).toHaveLength(0);
  });

  it("shows an error when the list cannot load", async () => {
    stubApi({
      "GET /api/oauth/grants": () => {
        throw new TypeError("fetch failed");
      },
    });
    const container = await renderSection();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach the server",
    );
  });

  it("asks for confirmation, revokes, removes the row and reports success", async () => {
    const fetchMock = stubApi({
      "GET /api/oauth/grants": [{ grants: [usedGrant, unusedGrant] }, 200],
      "DELETE /api/oauth/grants/g1": [null, 204],
    });
    const container = await renderSection();

    await click(button(container, "Revoke Claude"));
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Revoke Claude?");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/oauth/grants/g1",
      expect.anything(),
    );

    await click(button(container, "Revoke access"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/grants/g1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0]?.textContent).toContain("Claude Desktop");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Revoked "Claude"',
    );
  });

  it("cancelling the confirmation keeps the grant without a request", async () => {
    const fetchMock = stubApi({
      "GET /api/oauth/grants": [{ grants: [usedGrant] }, 200],
    });
    const container = await renderSection();

    await click(button(container, "Revoke Claude"));
    await click(button(container, "Cancel"));

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(rows(container)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the failure and keeps the row when revocation fails", async () => {
    stubApi({
      "GET /api/oauth/grants": [{ grants: [usedGrant] }, 200],
      "DELETE /api/oauth/grants/g1": [
        { error: "Internal server error", code: "internal_error" },
        500,
      ],
    });
    const container = await renderSection();

    await click(button(container, "Revoke Claude"));
    await click(button(container, "Revoke access"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Internal server error",
    );
    expect(rows(container)).toHaveLength(1);
    expect(button(container, "Revoke access")?.disabled).toBe(false);
  });

  it("drops a grant that is already gone and says so", async () => {
    stubApi({
      "GET /api/oauth/grants": [{ grants: [usedGrant] }, 200],
      "DELETE /api/oauth/grants/g1": [
        { error: "Not found", code: "not_found" },
        404,
      ],
    });
    const container = await renderSection();

    await click(button(container, "Revoke Claude"));
    await click(button(container, "Revoke access"));

    expect(rows(container)).toHaveLength(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "already disconnected",
    );
  });
});
