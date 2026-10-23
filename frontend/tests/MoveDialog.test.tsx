/**
 * Frontend tests for moving a file (issue #14): the MoveDialog folder
 * picker and its Files page wiring (listing and search rows open it, a
 * successful move shows an inline success alert and refreshes the view).
 * Follows the existing component test conventions: createRoot into jsdom,
 * act, stubbed global fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { MoveDialog } from "../src/components/MoveDialog";
import type { MoveDialogProps } from "../src/components/MoveDialog";
import { SessionContext } from "../src/auth/sessionContext";
import type { SessionValue } from "../src/auth/sessionContext";
import { FilesPage } from "../src/pages/Files";
import type { FileEntry, SearchResult } from "../src/api/client";

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

/** Wait for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** A promise that never settles (an eternally in-flight request). */
function never<T>(): Promise<T> {
  const { promise } = Promise.withResolvers<T>();
  return promise;
}

/** Flush pending microtasks and timers inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await delay(0);
  });
}

/** A handler for one stubbed request: returns the response to serve. */
type Handler = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Stub global fetch with a router keyed by "METHOD url". Unmatched
 * requests reject so a test notices an unexpected call.
 *
 * @param routes - the stubbed routes
 * @returns the fetch mock for assertions
 */
function stubApi(routes: Record<string, Handler>): Mock {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const handler = routes[`${method} ${url}`];
    if (!handler) {
      return Promise.reject(new Error(`Unhandled request: ${method} ${url}`));
    }
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * A listing handler returning the given subfolders.
 *
 * @param folders - subfolder base names
 * @param nextCursor - continuation token, or null
 * @returns the handler
 */
function folderListing(
  folders: string[],
  nextCursor: string | null = null,
): Handler {
  return () =>
    Promise.resolve(jsonResponse({ folders, files: [], nextCursor }));
}

/** The file being moved, as the listing hands it to the dialog. */
const file: FileEntry = {
  key: "users/alice/docs/a.txt",
  name: "a.txt",
  size: 10,
  lastModified: "2026-08-12T00:00:00.000Z",
};

/**
 * Render the MoveDialog into jsdom with base props overridable per test.
 *
 * @param props - prop overrides
 * @returns the container element holding the rendered dialog
 */
async function renderDialog(
  props: Partial<MoveDialogProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: MoveDialogProps = {
    file,
    folder: "docs/",
    rootLabel: "Home",
    onMoved: () => {},
    onClose: () => {},
  };
  await act(async () => {
    root.render(<MoveDialog {...baseProps} {...props} />);
  });
  await flush();
  return container;
}

/**
 * Find a button by its exact trimmed text or accessible name.
 *
 * @param scope - the element to search in
 * @param name - text content or aria-label
 * @returns the button, or undefined
 */
function button(
  scope: ParentNode,
  name: string,
): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name,
  );
}

/** The dialog's destination breadcrumb trail. */
function crumbs(container: HTMLElement): HTMLElement {
  const nav = container.querySelector(
    'nav[aria-label="Destination folder"]',
  ) as HTMLElement | null;
  expect(nav).not.toBeNull();
  return nav as HTMLElement;
}

/** The dialog's subfolder list. */
function folderList(container: HTMLElement): HTMLElement {
  const list = container.querySelector(
    'ul[aria-label="Folders"]',
  ) as HTMLElement | null;
  expect(list).not.toBeNull();
  return list as HTMLElement;
}

/**
 * Click a button and drain the resulting fetch chain.
 *
 * @param target - the button to click
 */
async function click(target: HTMLButtonElement | undefined): Promise<void> {
  expect(target).toBeDefined();
  await act(async () => {
    target?.click();
  });
  await flush();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("MoveDialog", () => {
  it("opens as a modal dialog at the file's current folder", async () => {
    const fetchMock = stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing([
        "Archive",
        "Reports",
      ]),
    });
    const container = await renderDialog();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("a.txt");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files?prefix=docs%2F&space=own",
      expect.anything(),
    );
    expect(crumbs(container).textContent).toContain("Home");
    expect(crumbs(container).textContent).toContain("docs");
    expect(folderList(container).textContent).toContain("Archive");
    expect(folderList(container).textContent).toContain("Reports");
    // Moving into the folder the file is already in is a no-op.
    expect(button(container, "Move here")?.disabled).toBe(true);
  });

  it("shows a loading indicator while the folders load", async () => {
    stubApi({ "GET /api/files?prefix=docs%2F&space=own": () => never() });
    const container = await renderDialog();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Loading folders");
  });

  it("navigates into a subfolder and back up via the breadcrumb", async () => {
    const fetchMock = stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing(["Reports"]),
      "GET /api/files?prefix=docs%2FReports%2F&space=own": folderListing([]),
      "GET /api/files?space=own": folderListing(["docs", "photos"]),
    });
    const container = await renderDialog();

    await click(button(folderList(container), "Reports"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files?prefix=docs%2FReports%2F&space=own",
      expect.anything(),
    );
    expect(crumbs(container).textContent).toContain("Reports");
    expect(container.textContent).toContain("No subfolders");
    expect(button(container, "Move here")?.disabled).toBe(false);

    await click(button(crumbs(container), "Home"));
    expect(folderList(container).textContent).toContain("photos");
    expect(button(container, "Move here")?.disabled).toBe(false);

    // Back into the file's own folder: Move here is disabled again.
    await click(button(folderList(container), "docs"));
    expect(button(container, "Move here")?.disabled).toBe(true);
  });

  it("moves the file to the chosen folder and reports the destination", async () => {
    const onMoved = vi.fn();
    const fetchMock = stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing(["Reports"]),
      "GET /api/files?prefix=docs%2FReports%2F&space=own": folderListing([]),
      "POST /api/files/move": () =>
        Promise.resolve(
          jsonResponse({ key: "users/alice/docs/Reports/a.txt" }),
        ),
    });
    const container = await renderDialog({ onMoved });

    await click(button(folderList(container), "Reports"));
    await click(button(container, "Move here"));

    const moveCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/files/move",
    );
    expect(moveCall).toBeDefined();
    expect(JSON.parse(String((moveCall?.[1] as RequestInit).body))).toEqual({
      space: "own",
      key: "users/alice/docs/a.txt",
      folder: "docs/Reports/",
    });
    expect(onMoved).toHaveBeenCalledWith("docs/Reports/");
  });

  it("disables the actions and shows a pending state while moving", async () => {
    stubApi({
      "GET /api/files?space=own": folderListing(["docs"]),
      "GET /api/files?prefix=docs%2F&space=own": folderListing([]),
      "POST /api/files/move": () => never(),
    });
    const container = await renderDialog();

    await click(button(crumbs(container), "Home"));
    await click(button(container, "Move here"));

    const pending = button(container, "Moving...");
    expect(pending?.disabled).toBe(true);
    expect(button(container, "Cancel")?.disabled).toBe(true);
  });

  it("shows a refused move in the dialog and keeps it open", async () => {
    const onMoved = vi.fn();
    stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing(["Reports"]),
      "GET /api/files?prefix=docs%2FReports%2F&space=own": folderListing([]),
      "POST /api/files/move": () =>
        Promise.resolve(
          jsonResponse(
            {
              error: 'A file named "a.txt" already exists in that folder',
              code: "already_exists",
            },
            409,
          ),
        ),
    });
    const container = await renderDialog({ onMoved });

    await click(button(folderList(container), "Reports"));
    await click(button(container, "Move here"));

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'A file named "a.txt" already exists in that folder',
    );
    expect(onMoved).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button(container, "Move here")?.disabled).toBe(false);
  });

  it("shows a folder listing failure inline with Retry", async () => {
    let calls = 0;
    stubApi({
      "GET /api/files?prefix=docs%2F&space=own": () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? jsonResponse({ error: "Storage unavailable", code: "s3" }, 502)
            : jsonResponse({
                folders: ["Reports"],
                files: [],
                nextCursor: null,
              }),
        );
      },
    });
    const container = await renderDialog();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Storage unavailable");
    await click(button(container, "Retry"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(folderList(container).textContent).toContain("Reports");
  });

  it("loads more folders when the listing is paginated", async () => {
    stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing(["A"], "c1"),
      "GET /api/files?prefix=docs%2F&cursor=c1&space=own": folderListing(["B"]),
    });
    const container = await renderDialog();

    expect(folderList(container).textContent).not.toContain("B");
    await click(button(container, "Load more folders"));
    expect(folderList(container).textContent).toContain("A");
    expect(folderList(container).textContent).toContain("B");
    expect(button(container, "Load more folders")).toBeUndefined();
  });

  it("moves within a shared space, rooted at the mount", async () => {
    const onMoved = vi.fn();
    const fetchMock = stubApi({
      "GET /api/files?space=shared%3Ashare-1": folderListing(["inbox"]),
      "GET /api/files?prefix=inbox%2F&space=shared%3Ashare-1": folderListing(
        [],
      ),
      "POST /api/files/move": () =>
        Promise.resolve(jsonResponse({ key: "inbox/plan.txt" })),
    });
    const container = await renderDialog({
      file: { ...file, key: "plan.txt", name: "plan.txt" },
      space: "shared:share-1",
      folder: "",
      rootLabel: "projects",
      onMoved,
    });

    expect(crumbs(container).textContent).toContain("projects");
    expect(button(container, "Move here")?.disabled).toBe(true);
    await click(button(folderList(container), "inbox"));
    await click(button(container, "Move here"));

    const moveCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/files/move",
    );
    expect(JSON.parse(String((moveCall?.[1] as RequestInit).body))).toEqual({
      space: "shared:share-1",
      key: "plan.txt",
      folder: "inbox/",
    });
    expect(onMoved).toHaveBeenCalledWith("inbox/");
  });

  it("cancels without any move request", async () => {
    const onClose = vi.fn();
    const fetchMock = stubApi({
      "GET /api/files?prefix=docs%2F&space=own": folderListing([]),
    });
    const container = await renderDialog({ onClose });

    await click(button(container, "Cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/files/move"),
    ).toBe(false);
  });
});

const session: SessionValue = {
  user: {
    id: "u1",
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
    isAdmin: false,
  },
  loading: false,
  refresh: async () => {},
  signOut: async () => {},
};

/** A search result for a file in the projects folder. */
const searchResult: SearchResult = {
  name: "Q3-Report.pdf",
  path: "projects",
  key: "users/alice/projects/Q3-Report.pdf",
  space: "own",
  match: "name",
};

/**
 * Render the Files page with a session and stubbed routes.
 *
 * @param routes - the stubbed API routes
 * @returns the container holding the page
 */
async function renderFilesPage(
  routes: Record<string, Handler>,
): Promise<HTMLElement> {
  stubApi({
    "GET /api/shares": () =>
      Promise.resolve(jsonResponse({ incoming: [], outgoing: [] })),
    ...routes,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/files"]}>
        <SessionContext.Provider value={session}>
          <FilesPage />
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

describe("Files page move wiring", () => {
  it("moves a listing row, shows a success alert and refreshes the listing", async () => {
    let rootListings = 0;
    let moved = false;
    const container = await renderFilesPage({
      "GET /api/files?space=own": () => {
        rootListings += 1;
        return Promise.resolve(
          jsonResponse({
            folders: ["docs"],
            files: moved
              ? []
              : [
                  {
                    key: "users/alice/notes.txt",
                    name: "notes.txt",
                    size: 64,
                    lastModified: "2026-08-10T12:00:00.000Z",
                  },
                ],
            nextCursor: null,
          }),
        );
      },
      "GET /api/files?prefix=docs%2F&space=own": folderListing(["Reports"]),
      "GET /api/files?prefix=docs%2FReports%2F&space=own": folderListing([]),
      "POST /api/files/move": () => {
        moved = true;
        return Promise.resolve(
          jsonResponse({ key: "users/alice/docs/Reports/notes.txt" }),
        );
      },
    });
    const row = Array.from(container.querySelectorAll("li.list-row")).find(
      (el) => el.textContent?.includes("notes.txt"),
    ) as HTMLElement;
    await click(button(row, "Move"));

    // The picker starts at the row's folder: the space root.
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    await click(button(folderList(dialog), "docs"));
    await click(button(folderList(dialog), "Reports"));
    const listingsBeforeMove = rootListings;
    await click(button(dialog, "Move here"));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const success = container.querySelector(".alert-success");
    expect(success?.getAttribute("role")).toBe("status");
    expect(success?.textContent).toContain('Moved "notes.txt" to docs/Reports');
    expect(rootListings).toBeGreaterThan(listingsBeforeMove);
    expect(
      Array.from(container.querySelectorAll("li.list-row")).some((el) =>
        el.textContent?.includes("notes.txt"),
      ),
    ).toBe(false);
  });

  it("moves a search result from its folder and re-runs the search", async () => {
    let searches = 0;
    const container = await renderFilesPage({
      "GET /api/files?space=own": folderListing(["projects"]),
      "GET /api/files?prefix=projects%2F&space=own": folderListing([]),
      "GET /api/files/search?q=report": () => {
        searches += 1;
        return Promise.resolve(
          jsonResponse({ results: [searchResult], capped: false }),
        );
      },
      "POST /api/files/move": () =>
        Promise.resolve(jsonResponse({ key: "users/alice/Q3-Report.pdf" })),
    });
    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "report");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form[role="search"]')
        ?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    await flush();
    expect(searches).toBe(1);

    await click(button(container, "Move Q3-Report.pdf"));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    // The picker starts at the result's folder (projects/).
    expect(crumbs(dialog).textContent).toContain("projects");
    expect(button(dialog, "Move here")?.disabled).toBe(true);
    await click(button(crumbs(dialog), "Home"));
    await click(button(dialog, "Move here"));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".alert-success")?.textContent).toContain(
      'Moved "Q3-Report.pdf" to Home',
    );
    expect(searches).toBe(2);
  });
});
