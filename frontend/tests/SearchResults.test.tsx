/**
 * Frontend tests for file search (007-file-search, US1, T009): the
 * SearchResults component and the Files page wiring (submit swaps the
 * folder listing for results, clearing restores it, a result click
 * navigates to the containing folder). Follows the existing component
 * test conventions: createRoot into jsdom, act, stubbed global fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import type { SessionValue } from "../src/auth/sessionContext";
import { SearchResults } from "../src/components/SearchResults";
import type { SearchResult } from "../src/api/client";
import { FilesPage } from "../src/pages/Files";

/** A search result fixture at a nested path. */
const nestedResult: SearchResult = {
  name: "Q3-Report.pdf",
  path: "projects",
  key: "users/alice/projects/Q3-Report.pdf",
  space: "own",
  match: "name",
};
/** A search result fixture at the space root. */
const rootResult: SearchResult = {
  name: "report ideas.txt",
  path: "",
  key: "users/alice/report ideas.txt",
  space: "own",
  match: "name",
};

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
/** Flush pending microtasks and timers inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await delay(0);
  });
}

/** A promise that never settles (an eternally in-flight request). */
function never<T>(): Promise<T> {
  const { promise } = Promise.withResolvers<T>();
  return promise;
}

/** Wait for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Set a controlled input's value the way a real keystroke would: React
 * deduplicates plain `.value` writes, so the native setter must be used
 * before dispatching the input event.
 *
 * @param input - the controlled input
 * @param value - the value to type
 */
function typeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Render the SearchResults component for a query. */
function renderResults(
  props: Partial<Parameters<typeof SearchResults>[0]> = {},
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SearchResults query="report" onOpenResult={() => {}} {...props} />,
    );
  });
  return container;
}

describe("SearchResults (T009)", () => {
  it("renders name, path and match badge for each result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [nestedResult, rootResult],
          capped: false,
        }),
      ),
    );
    const container = renderResults();
    await flush();

    const rows = container.querySelectorAll("li.list-row");
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("Q3-Report.pdf");
    expect(container.textContent).toContain("report ideas.txt");
    // Path breadcrumb: nested shows the folder trail, root shows Home.
    expect(container.textContent).toContain("projects");
    // Match-type badge.
    expect(container.textContent).toContain("Name match");
  });

  it("shows a searching state while the request is in flight", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(never<Response>()));
    const container = renderResults();

    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelectorAll("li.list-row")).toHaveLength(0);
  });

  it("shows a no-results empty state without an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ results: [], capped: false })),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).toContain("No files or folders match");
    expect(container.querySelector(".alert-error")).toBeNull();
  });

  it("shows a refine hint when the result list is capped", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: true }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).toMatch(/refine your query/i);
  });

  it("calls onOpenResult with the clicked result", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: false }),
        ),
    );
    const onOpenResult = vi.fn();
    const container = renderResults({ onOpenResult });
    await flush();

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Q3-Report.pdf"),
    );
    expect(link).not.toBeNull();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenResult).toHaveBeenCalledWith(nestedResult);
  });

  it("surfaces a failed search as an error with Retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "boom", code: "internal_error" }, 500),
      )
      .mockResolvedValue(
        jsonResponse({ results: [nestedResult], capped: false }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as Mock);
    const container = renderResults();
    await flush();

    expect(container.querySelector(".alert-error")).not.toBeNull();

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    await act(async () => {
      retry?.click();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".alert-error")).toBeNull();
    expect(container.querySelectorAll("li.list-row")).toHaveLength(1);
  });

  it("refreshes the session on 401 instead of showing an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "Not signed in", code: "unauthorized" }, 401),
        ),
    );
    const onSessionExpired = vi.fn();
    const container = renderResults({ onSessionExpired });
    await flush();

    expect(onSessionExpired).toHaveBeenCalled();
    expect(container.querySelector(".alert-error")).toBeNull();
  });
});

/**
 * Render the Files page with a session and a fetch router: folder
 * listings and shares come back as fixtures, searches as `searchBody`.
 *
 * @param searchBody - response for /api/files/search
 * @param searchDelay - optional delay applied to the search response
 * @param sharesBody - response for /api/shares (no shares by default)
 * @returns fetch mock and container
 */
async function renderFilesPage(
  searchBody: unknown,
  searchDelay = 0,
  sharesBody: unknown = { incoming: [], outgoing: [] },
): Promise<{ fetchMock: Mock; container: HTMLElement }> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/files/search")) {
      if (searchDelay > 0) await delay(searchDelay);
      return jsonResponse(searchBody);
    }
    if (url.startsWith("/api/files/download-url")) {
      return jsonResponse({ url: "https://storage.test/object" });
    }
    if (url.startsWith("/api/files")) {
      return jsonResponse({
        folders: ["docs"],
        files: [
          {
            key: "users/alice/notes.txt",
            name: "notes.txt",
            size: 64,
            lastModified: "2026-08-10T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    if (url.startsWith("/api/shares")) {
      return jsonResponse(sharesBody);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

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
  return { fetchMock, container };
}

describe("Files page download opens a new window", () => {
  it("opens a listing row's presigned URL in a new window", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = await renderFilesPage({
      results: [],
      capped: false,
    });

    const row = Array.from(container.querySelectorAll("li.list-row")).find(
      (el) => el.textContent?.includes("notes.txt"),
    ) as HTMLElement;
    expect(row).toBeDefined();
    await act(async () => {
      row
        .querySelector('button[aria-label="Download"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(open).toHaveBeenCalledWith("https://storage.test/object", "_blank");
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("Files page search wiring (T009/T012)", () => {
  it("swaps the folder listing for results on submit and restores it on clear", async () => {
    const { container } = await renderFilesPage({
      results: [nestedResult],
      capped: false,
    });

    // The listing is visible first.
    expect(container.textContent).toContain("notes.txt");
    expect(container.textContent).not.toContain("Q3-Report.pdf");

    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInput(input, "report");
    });
    const form = container.querySelector('form[role="search"]');
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    await flush();

    // Results replace the listing.
    expect(container.textContent).toContain("Q3-Report.pdf");
    expect(container.textContent).not.toContain("notes.txt");

    const clear = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear",
    );
    await act(async () => {
      clear?.click();
    });
    await flush();

    // Clearing restores the folder listing.
    expect(container.textContent).toContain("notes.txt");
    expect(container.textContent).not.toContain("Q3-Report.pdf");
  });

  it("navigates to the containing folder when a result is clicked", async () => {
    const { container } = await renderFilesPage({
      results: [nestedResult],
      capped: false,
    });

    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInput(input, "report");
    });
    const form = container.querySelector('form[role="search"]');
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    await flush();

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Q3-Report.pdf"),
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The listing for projects/ replaced the results; the breadcrumb
    // trail shows the containing folder.
    expect(container.textContent).not.toContain("Name match");
    expect(
      container.querySelector('nav[aria-label="Breadcrumbs"]')?.textContent,
    ).toContain("projects");
  });
});

describe("SearchResults snippet rendering (T015)", () => {
  /** A content match carrying the contract's marked snippet. */
  const contentResult: SearchResult = {
    name: "meeting.txt",
    path: "notes",
    key: "users/alice/notes/meeting.txt",
    space: "own",
    match: "content",
    snippet: "…confirmed the <mark>budget review</mark> before noon…",
  };

  it("renders a content match with a marked snippet and a Content match badge", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [contentResult], capped: false }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).toContain("Content match");
    // The matched text renders inside a real <mark> element.
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("budget review");
    // The surrounding document text is visible too (FR-005).
    expect(container.textContent).toContain("before noon");
  });

  it("renders no snippet for name matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: false }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).toContain("Name match");
    expect(container.querySelector("mark")).toBeNull();
  });

  it("renders snippet document text as text, never as HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            {
              ...contentResult,
              // A hostile document's text must not become markup.
              snippet: "<mark>needle</mark> <img src=x onerror=alert(1)>",
            },
          ],
          capped: false,
        }),
      ),
    );
    const container = renderResults();
    await flush();

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("SearchResults shared results (T020)", () => {
  /** A result from a folder alice shared with the signed-in user. */
  const sharedResult: SearchResult = {
    name: "plan.txt",
    path: "",
    key: "plan.txt",
    space: "shared:share-1",
    sharedBy: "alice",
    match: "name",
  };

  /** Submit the Files page search box for `renderFilesPage` output. */
  async function submitSearch(container: HTMLElement): Promise<void> {
    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInput(input, "plan");
    });
    const form = container.querySelector('form[role="search"]');
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    await flush();
  }

  it("labels results from a shared mount with the sharer's username", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [sharedResult], capped: false }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).toContain("Shared by alice");
  });

  it("does not label own-space results", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: false }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(container.textContent).not.toContain("Shared by");
  });

  it("issues the download against the result's shared space", async () => {
    const { container, fetchMock } = await renderFilesPage({
      results: [sharedResult],
      capped: false,
    });
    await submitSearch(container);

    const row = container.querySelector("li.list-row") as HTMLElement;
    await act(async () => {
      (
        row.querySelector('button[aria-label="Download plan.txt"]') ??
        row.querySelector("button")
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/files/download-url?key=plan.txt&space=shared%3Ashare-1",
      ),
      expect.anything(),
    );
  });

  it("opens the result's presigned URL in a new window on download", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = await renderFilesPage({
      results: [sharedResult],
      capped: false,
    });
    await submitSearch(container);

    const row = container.querySelector("li.list-row") as HTMLElement;
    await act(async () => {
      (
        row.querySelector('button[aria-label="Download plan.txt"]') ??
        row.querySelector("button")
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(open).toHaveBeenCalledWith("https://storage.test/object", "_blank");
  });

  it("navigates into the shared space from a result click", async () => {
    const { container, fetchMock } = await renderFilesPage({
      results: [{ ...sharedResult, path: "projects", key: "docs/report.pdf" }],
      capped: false,
    });
    await submitSearch(container);

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("plan.txt"),
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The listing for the shared space's projects folder replaces the
    // results (contract routing: /files?space=shared:<id>&prefix=<folder>).
    const listingCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("space=shared%3Ashare-1"));
    expect(listingCall).toBeDefined();
    expect(listingCall).toContain("prefix=projects%2F");
    expect(container.textContent).not.toContain("Name match");
  });
});

describe("SearchResults move action", () => {
  it("renders a Move button per result that calls onMove with the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: false }),
        ),
    );
    const onMove = vi.fn();
    const container = renderResults({ onMove });
    await flush();

    const button = container.querySelector(
      'button[aria-label="Move Q3-Report.pdf"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Move");
    act(() => {
      button?.click();
    });
    expect(onMove).toHaveBeenCalledWith(nestedResult);
  });

  it("renders no Move button when no handler is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [nestedResult], capped: false }),
        ),
    );
    const container = renderResults();
    await flush();

    expect(
      container.querySelector('button[aria-label="Move Q3-Report.pdf"]'),
    ).toBeNull();
  });
});

describe("SearchResults folder results (#13)", () => {
  /** An own-space folder match, nested one level. */
  const ownFolder: SearchResult = {
    name: "old plans",
    path: "work",
    key: "work/old plans/",
    space: "own",
    match: "folder",
  };
  /** The root of a folder alice shared with the signed-in user. */
  const mountRoot: SearchResult = {
    name: "team",
    path: "",
    key: "",
    space: "shared:share-1",
    sharedBy: "alice",
    match: "folder",
  };

  /** Submit the Files page search box for `renderFilesPage` output. */
  async function submitSearch(container: HTMLElement): Promise<void> {
    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInput(input, "plans");
    });
    const form = container.querySelector('form[role="search"]');
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    await flush();
  }

  it("renders a folder row with its parent path and a Folder badge, without file actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [ownFolder, nestedResult], capped: false }),
        ),
    );
    const container = renderResults({
      onDownload: () => {},
      onShare: () => {},
      onDelete: () => {},
      onMove: () => {},
      onShareFolder: () => {},
    });
    await flush();

    const folderRow = container.querySelectorAll("li.list-row")[0]!;
    expect(folderRow.textContent).toContain("old plans");
    expect(folderRow.textContent).toContain("Folder");
    expect(folderRow.textContent).not.toContain("Name match");
    // The second line is the parent folder, not the folder itself.
    expect(folderRow.querySelector("p")?.textContent).toBe("work");
    // File-only actions never render on a folder row.
    expect(
      folderRow.querySelector('button[aria-label="Download old plans"]'),
    ).toBeNull();
    expect(
      folderRow.querySelector('button[aria-label="Delete old plans"]'),
    ).toBeNull();
    expect(
      folderRow.querySelector('button[aria-label="Move old plans"]'),
    ).toBeNull();
    expect(
      folderRow.querySelectorAll('button[aria-label="Share old plans"]'),
    ).toHaveLength(1);
  });

  it("offers no Share button on a folder from a shared mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ results: [mountRoot], capped: false }),
        ),
    );
    const container = renderResults({ onShareFolder: () => {} });
    await flush();

    const row = container.querySelector("li.list-row")!;
    expect(row.textContent).toContain("Shared by alice");
    expect(row.querySelector("button")).toBeNull();
    // A mount sits at the recipient's Home.
    expect(row.querySelector("p")?.textContent).toBe("Home");
  });

  it("opens the folder itself when a folder result is clicked", async () => {
    const { container, fetchMock } = await renderFilesPage({
      results: [ownFolder],
      capped: false,
    });
    await submitSearch(container);

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("old plans"),
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const listingCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("prefix=work%2Fold+plans%2F"));
    expect(listingCall).toBeDefined();
    expect(
      container.querySelector('nav[aria-label="Breadcrumbs"]')?.textContent,
    ).toContain("old plans");
  });

  it("opens a shared mount at its root from its folder result", async () => {
    const { container, fetchMock } = await renderFilesPage({
      results: [mountRoot],
      capped: false,
    });
    await submitSearch(container);

    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("team"),
    );
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const listingCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes("space=shared%3Ashare-1"));
    expect(listingCall).toBeDefined();
    expect(listingCall).not.toContain("prefix=");
  });

  it("opens the folder share dialog for exactly that folder from an own-space result", async () => {
    const { container } = await renderFilesPage(
      { results: [ownFolder], capped: false },
      0,
      {
        incoming: [],
        // A same-named root folder's share must not show up: the dialog
        // filters by the folder's full space-relative prefix.
        outgoing: [
          {
            id: "s1",
            folder: "work/old plans/",
            folderName: "old plans",
            recipient: { id: "u-bob", username: "bob" },
            createdAt: "2026-08-10T12:00:00.000Z",
          },
          {
            id: "s2",
            folder: "old plans/",
            folderName: "old plans",
            recipient: { id: "u-carol", username: "carol" },
            createdAt: "2026-08-10T12:00:00.000Z",
          },
        ],
      },
    );
    await submitSearch(container);

    const share = container.querySelector(
      'button[aria-label="Share old plans"]',
    );
    await act(async () => {
      share?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(
      container.querySelector("#share-folder-dialog-title")?.textContent,
    ).toBe("Share old plans");
    expect(
      container.querySelector('button[aria-label="Revoke share for bob"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Revoke share for carol"]'),
    ).toBeNull();
  });
});
