import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ShareDialog } from "../src/components/ShareDialog";
import type { ShareDialogProps } from "../src/components/ShareDialog";
import type { ShareOutgoing } from "../src/api/client";

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

/** A stubbed API route: a JSON body (or null for 204) plus the status. */
interface StubRoute {
  body: unknown;
  status: number;
}

/**
 * Stub global fetch to serve the share API: user search, share creation
 * and revocation. Routes are keyed by "METHOD url" and each call gets a
 * fresh Response so repeated calls are not blocked by a consumed body.
 *
 * @param routes - the stubbed routes
 * @returns the fetch mock for assertions
 */
function stubSharesApi(routes: Record<string, StubRoute>): Mock {
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
        if (route.body === null) {
          return Promise.resolve(new Response(null, { status: route.status }));
        }
        return Promise.resolve(jsonResponse(route.body, route.status));
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** A stored outgoing share of `projects/` to bob. */
const outgoingShare: ShareOutgoing = {
  id: "share-1",
  folder: "projects/",
  folderName: "projects",
  recipient: { id: "user-bob", username: "bob" },
  createdAt: "2026-08-10T12:00:00.000Z",
};

/**
 * Render the ShareDialog into jsdom with base props overridable per test.
 *
 * @param props - prop overrides
 * @returns the container element holding the rendered dialog
 */
async function renderDialog(
  props: Partial<ShareDialogProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: ShareDialogProps = {
    folder: "projects/",
    folderName: "projects",
    shares: [],
    onClose: () => {},
    onSharesChanged: () => {},
  };
  await act(async () => {
    root.render(<ShareDialog {...baseProps} {...props} />);
  });
  return container;
}

/**
 * Type into the recipient search box and advance past the 300ms debounce
 * so the search effect runs to completion.
 *
 * @param container - the rendered dialog
 * @param query - text to type
 */
async function searchFor(container: HTMLElement, query: string): Promise<void> {
  const input = container.querySelector(
    "#share-recipient-search",
  ) as HTMLInputElement;
  // React 19 tracks controlled input values with a private descriptor, so
  // assigning .value directly does not fire onChange; the prototype setter
  // updates the DOM node (and React's tracker) the way a keystroke would.
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(300);
  });
}

/**
 * Click the search-result button for the given username.
 *
 * @param container - the rendered dialog
 * @param username - the result to pick
 */
async function selectResult(
  container: HTMLElement,
  username: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === username,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
}

/**
 * Click the dialog's Add button (enabled once a recipient is selected).
 *
 * @param container - the rendered dialog
 */
async function clickAdd(container: HTMLElement): Promise<void> {
  const addButton = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Add",
  );
  expect(addButton).toBeDefined();
  await act(async () => {
    addButton?.click();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("ShareDialog", () => {
  it("renders user search matches and selects one (T016)", async () => {
    vi.useFakeTimers();
    stubSharesApi({
      "GET /api/users?q=bo": {
        status: 200,
        body: { users: [{ id: "user-bob", username: "bob" }] },
      },
    });
    const container = await renderDialog();

    // The search field is labelled and the dialog is an alertdialog.
    const input = container.querySelector(
      "#share-recipient-search",
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    await searchFor(container, "bo");

    // The match renders as a pickable result.
    const resultButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "bob",
    );
    expect(resultButton).toBeDefined();

    // Picking it fills the input and clears the results.
    await selectResult(container, "bob");
    expect(input.value).toBe("bob");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "bob" &&
          candidate.closest('[aria-label="Search results"]'),
      ),
    ).toBe(false);
  });

  it("adds the selected recipient via POST /api/shares and refreshes the list (T016)", async () => {
    vi.useFakeTimers();
    const onSharesChanged = vi.fn();
    const fetchMock = stubSharesApi({
      "GET /api/users?q=bo": {
        status: 200,
        body: { users: [{ id: "user-bob", username: "bob" }] },
      },
      "POST /api/shares": { status: 201, body: { share: outgoingShare } },
    });
    const container = await renderDialog({ onSharesChanged });

    await searchFor(container, "bo");
    await selectResult(container, "bob");
    await clickAdd(container);

    // The create request carries the folder and the picked username.
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/shares" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(
      (postCall as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({ folder: "projects/", recipientUsername: "bob" });
    expect(onSharesChanged).toHaveBeenCalledTimes(1);
  });

  it("surfaces a duplicate-share refusal (409 already_shared) (T016)", async () => {
    vi.useFakeTimers();
    stubSharesApi({
      "GET /api/users?q=bo": {
        status: 200,
        body: { users: [{ id: "user-bob", username: "bob" }] },
      },
      "POST /api/shares": {
        status: 409,
        body: {
          error: 'Folder "projects" is already shared with "bob"',
          code: "already_shared",
        },
      },
    });
    const container = await renderDialog();

    await searchFor(container, "bo");
    await selectResult(container, "bob");
    await clickAdd(container);

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes('already shared with "bob"'),
      ),
    ).toBe(true);
  });

  it("surfaces a self-share refusal (400 cannot_share_with_self) (T016)", async () => {
    vi.useFakeTimers();
    stubSharesApi({
      "GET /api/users?q=alice": {
        status: 200,
        body: { users: [{ id: "user-alice", username: "alice" }] },
      },
      "POST /api/shares": {
        status: 400,
        body: {
          error: "You cannot share a folder with yourself",
          code: "cannot_share_with_self",
        },
      },
    });
    const container = await renderDialog();

    await searchFor(container, "alice");
    await selectResult(container, "alice");
    await clickAdd(container);

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes("cannot share a folder with yourself"),
      ),
    ).toBe(true);
  });

  it("lists the folder's recipients with share dates and a revoke action that calls the API (T016)", async () => {
    const onSharesChanged = vi.fn();
    const fetchMock = stubSharesApi({
      "DELETE /api/shares/share-1": { status: 204, body: null },
    });
    const container = await renderDialog({
      shares: [outgoingShare],
      onSharesChanged,
    });

    const list = container.querySelector(
      'ul[aria-label="Recipients of projects"]',
    );
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain("bob");
    // The share date is formatted from createdAt.
    expect(list?.textContent).toContain("2026");

    const revokeButton = container.querySelector(
      'button[aria-label="Revoke share for bob"]',
    ) as HTMLButtonElement | null;
    expect(revokeButton).not.toBeNull();

    await act(async () => {
      revokeButton?.click();
    });

    const deleteCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/shares/share-1" &&
        (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(onSharesChanged).toHaveBeenCalledTimes(1);
  });

  it("shows only the recipients of the dialog's folder (T016)", async () => {
    const otherShare: ShareOutgoing = {
      id: "share-2",
      folder: "docs/",
      folderName: "docs",
      recipient: { id: "user-carol", username: "carol" },
      createdAt: "2026-08-11T12:00:00.000Z",
    };
    const container = await renderDialog({
      shares: [outgoingShare, otherShare],
    });

    const list = container.querySelector(
      'ul[aria-label="Recipients of projects"]',
    );
    expect(list?.textContent).toContain("bob");
    expect(list?.textContent).not.toContain("carol");
  });

  it("shows the empty recipient state when the folder has no recipients (T016)", async () => {
    const container = await renderDialog();

    expect(container.textContent).toContain("No recipients yet");
  });
});
