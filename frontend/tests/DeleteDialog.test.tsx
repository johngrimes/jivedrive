import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DeleteDialog } from "../src/components/DeleteDialog";
import type { DeleteDialogProps } from "../src/components/DeleteDialog";
import type { FileEntry } from "../src/api/client";

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
 * Stub global fetch to serve the API. Routes are keyed by "METHOD url"
 * and each call gets a fresh Response so repeated calls are not blocked
 * by a consumed body.
 *
 * @param routes - the stubbed routes
 * @returns the fetch mock for assertions
 */
function stubApi(routes: Record<string, StubRoute>): Mock {
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

/** A file entry as the listing hands it to the dialog. */
const sharedFile: FileEntry = {
  key: "notes.txt",
  name: "notes.txt",
  size: 10,
  lastModified: "2026-08-12T00:00:00.000Z",
};

/**
 * Render the DeleteDialog into jsdom with base props overridable per test.
 *
 * @param props - prop overrides
 * @returns the container element holding the rendered dialog
 */
async function renderDialog(
  props: Partial<DeleteDialogProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: DeleteDialogProps = {
    file: sharedFile,
    onDeleted: () => {},
    onClose: () => {},
  };
  await act(async () => {
    root.render(<DeleteDialog {...baseProps} {...props} />);
  });
  return container;
}

/**
 * Click the dialog's Delete button.
 *
 * @param container - the rendered dialog
 */
async function clickDelete(container: HTMLElement): Promise<void> {
  const deleteButton = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Delete",
  );
  expect(deleteButton).toBeDefined();
  await act(async () => {
    deleteButton?.click();
  });
  // Drain the fetch/client promise chain, which `act` does not wait for:
  // yield once around a real timer so the event loop can turn.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("DeleteDialog", () => {
  it("deletes in the own space by default (space=own)", async () => {
    const onDeleted = vi.fn();
    const fetchMock = stubApi({
      "DELETE /api/files?key=users%2Falice%2Fa.txt&space=own": {
        status: 204,
        body: null,
      },
    });
    const container = await renderDialog({
      file: {
        key: "users/alice/a.txt",
        name: "a.txt",
        size: 10,
        lastModified: "2026-08-12T00:00:00.000Z",
      },
      onDeleted,
    });

    await clickDelete(container);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[0]).toBe(
      "/api/files?key=users%2Falice%2Fa.txt&space=own",
    );
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("deletes in a shared space with the space in the request (T027)", async () => {
    const onDeleted = vi.fn();
    const fetchMock = stubApi({
      "DELETE /api/files?key=notes.txt&space=shared%3Ashare-1": {
        status: 204,
        body: null,
      },
    });
    const container = await renderDialog({
      space: "shared:share-1",
      onDeleted,
    });

    await clickDelete(container);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCall).toBeDefined();
    // The mount-relative key goes with the shared-space identifier, so
    // the server composes the sharer's full key (R2).
    expect(deleteCall?.[0]).toBe(
      "/api/files?key=notes.txt&space=shared%3Ashare-1",
    );
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("surfaces a delete failure and keeps the dialog open", async () => {
    const onDeleted = vi.fn();
    stubApi({
      "DELETE /api/files?key=notes.txt&space=shared%3Ashare-1": {
        status: 404,
        body: { error: "The file does not exist", code: "not_found" },
      },
    });
    const container = await renderDialog({ space: "shared:share-1" });

    await clickDelete(container);

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes("The file does not exist"),
      ),
    ).toBe(true);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
