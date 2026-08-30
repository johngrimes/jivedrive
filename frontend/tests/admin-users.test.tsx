import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import { AdminUsersPage } from "../src/pages/AdminUsers";

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

/** A signed-in ADMIN session value for the page's context. */
const adminSession = {
  user: {
    id: "admin-1",
    username: "admin",
    bucket: "jivedrive-prod",
    prefix: "users/admin/",
    isAdmin: true,
  },
  loading: false,
  refresh: async () => {},
  signOut: async () => {},
};

/** A stubbed API route: a JSON body plus the HTTP status. */
interface StubRoute {
  body: unknown;
  status: number;
}

/**
 * A dynamic route handler, used when a test must control the response
 * timing (e.g. a deferred promise for in-flight assertions).
 */
type RouteHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Stub global fetch to serve the admin API: the initial user/invite
 * lists and the passkey-reset response, plus any test-supplied route
 * overrides. Routes are keyed by "METHOD url" and each call gets a
 * fresh Response so repeated GETs (initial load plus the reload after
 * an action) are not blocked by a consumed body.
 *
 * @param overrides - extra or replacing route entries
 * @returns the fetch mock for assertions
 */
function stubAdminApi(
  overrides: Record<string, StubRoute | RouteHandler> = {},
): Mock {
  const routes: Record<string, StubRoute | RouteHandler> = {
    "GET /api/admin/users": {
      status: 200,
      body: {
        users: [
          {
            id: "admin-1",
            username: "admin",
            bucket: "jivedrive-prod",
            prefix: "users/admin/",
            isAdmin: true,
            createdAt: "2026-08-10T12:00:00.000Z",
          },
          {
            id: "target-1",
            username: "kate",
            bucket: "jivedrive-prod",
            prefix: "users/kate/",
            isAdmin: false,
            createdAt: "2026-08-11T12:00:00.000Z",
          },
        ],
      },
    },
    "GET /api/admin/invites": { status: 200, body: { invites: [] } },
    "DELETE /api/admin/users/target-1/passkeys": {
      status: 200,
      body: {
        invite: {
          id: "inv-reset-1",
          username: "kate",
          bucket: "jivedrive-prod",
          prefix: "users/kate/",
          isAdmin: false,
          expiresAt: "2026-08-20T12:00:00.000Z",
          status: "pending",
        },
        link: "http://localhost:5173/register?token=reset-link",
      },
    },
  };
  Object.assign(routes, overrides);

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
          return Promise.resolve(route(url, init));
        }
        return Promise.resolve(jsonResponse(route.body, route.status));
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * Render the AdminUsersPage into jsdom with a signed-in admin session.
 *
 * @returns the container element holding the rendered page
 */
async function renderAdminUsers(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionContext.Provider value={adminSession}>
          <AdminUsersPage />
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AdminUsersPage", () => {
  it("surfaces the re-enrollment link and success notice after a passkey reset (T028)", async () => {
    const fetchMock = stubAdminApi();
    const container = await renderAdminUsers();

    // The users table lists the target; her row has a Reset passkeys
    // action (the signed-in admin's own row shows "(you)" instead).
    const usersTable = container.querySelector('table[aria-label="Users"]');
    expect(usersTable).not.toBeNull();
    const rows = Array.from(usersTable?.querySelectorAll("tbody tr") ?? []);
    const kateRow = rows.find((row) => row.textContent?.includes("kate"));
    expect(kateRow).toBeDefined();
    const resetButton = kateRow?.querySelector(
      'button[aria-label="Reset passkeys"]',
    ) as HTMLButtonElement | null;
    expect(resetButton).not.toBeNull();

    // Open the confirmation dialog and confirm the reset.
    await act(async () => {
      resetButton?.click();
    });
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    const confirmButton = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent?.trim() === "Reset passkeys");
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton?.click();
    });

    // The reset response's re-enrollment link is surfaced in a copyable
    // readonly input (reusing the generated-link card), and an explicit
    // success notice confirms the reset.
    const linkInput = container.querySelector(
      'input[readonly][aria-label="Re-enrollment link"]',
    ) as HTMLInputElement | null;
    expect(linkInput).not.toBeNull();
    expect(linkInput?.value).toBe(
      "http://localhost:5173/register?token=reset-link",
    );
    expect(container.textContent).toContain("Re-enrollment link for kate");
    expect(container.textContent).toContain(
      'Passkeys reset for "kate". Re-enrollment link created.',
    );

    // The DELETE was sent to the passkeys endpoint and the lists reloaded.
    const deleteCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/admin/users/target-1/passkeys" &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it("rebuilds a user's search index and reports it was started (T026)", async () => {
    const fetchMock = stubAdminApi({
      "POST /api/admin/users/target-1/reindex": {
        status: 202,
        body: { started: true },
      },
    });
    const container = await renderAdminUsers();

    const kateRow = Array.from(
      container.querySelectorAll('table[aria-label="Users"] tbody tr'),
    ).find((row) => row.textContent?.includes("kate"));
    expect(kateRow).toBeDefined();
    const rebuildButton = kateRow?.querySelector(
      'button[aria-label="Rebuild search index"]',
    ) as HTMLButtonElement | null;
    expect(rebuildButton).not.toBeNull();
    expect(rebuildButton?.disabled).toBe(false);

    await act(async () => {
      rebuildButton?.click();
    });

    // An explicit notice states the rebuild was started (constitution V:
    // no silent success); the scan itself runs in the background.
    expect(container.textContent).toContain(
      'Search index rebuild started for "kate".',
    );
    expect(
      (
        kateRow?.querySelector(
          'button[aria-label="Rebuild search index"]',
        ) as HTMLButtonElement | null
      )?.disabled,
    ).toBe(false);

    const postCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/admin/users/target-1/reindex" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
  });

  it("disables the row action while the rebuild is in flight (T026)", async () => {
    let resolveReindex: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveReindex = resolve;
    });
    const fetchMock = stubAdminApi({
      "POST /api/admin/users/target-1/reindex": () => pending,
    });
    const container = await renderAdminUsers();
    const kateRow = Array.from(
      container.querySelectorAll('table[aria-label="Users"] tbody tr'),
    ).find((row) => row.textContent?.includes("kate"));
    const rebuildButton = kateRow?.querySelector(
      'button[aria-label="Rebuild search index"]',
    ) as HTMLButtonElement | null;
    expect(rebuildButton).not.toBeNull();

    await act(async () => {
      rebuildButton?.click();
    });

    const inFlight = kateRow?.querySelector(
      'button[aria-label="Rebuild search index"]',
    ) as HTMLButtonElement | null;
    expect(inFlight?.disabled).toBe(true);
    expect(inFlight?.textContent).toContain("Rebuilding...");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    await act(async () => {
      resolveReindex(jsonResponse({ started: true }));
    });

    expect(container.textContent).toContain(
      'Search index rebuild started for "kate".',
    );
  });

  it("surfaces an explicit error when the rebuild fails (T026)", async () => {
    stubAdminApi({
      "POST /api/admin/users/target-1/reindex": {
        status: 500,
        body: { error: "Reconciliation failed", code: "internal" },
      },
    });
    const container = await renderAdminUsers();
    const kateRow = Array.from(
      container.querySelectorAll('table[aria-label="Users"] tbody tr'),
    ).find((row) => row.textContent?.includes("kate"));
    const rebuildButton = kateRow?.querySelector(
      'button[aria-label="Rebuild search index"]',
    ) as HTMLButtonElement | null;
    expect(rebuildButton).not.toBeNull();

    await act(async () => {
      rebuildButton?.click();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Reconciliation failed");
    expect(container.textContent).not.toContain("Search index rebuilt");
  });
});
