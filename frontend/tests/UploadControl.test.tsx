import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UploadControl } from "../src/components/UploadControl";
import type { UploadControlProps } from "../src/components/UploadControl";

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

/**
 * A minimal XMLHttpRequest double: the component PUTs the file body to
 * the presigned URL via XHR, and jsdom cannot open real network sockets.
 * Records every instance so tests can assert the target URL, and resolves
 * immediately with a 2xx status (the upload itself is the backend's job).
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 200;
  url = "";
  sent: unknown = null;
  upload: {
    onprogress: ((event: { loaded: number; total: number }) => void) | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(): void {}

  send(body: unknown): void {
    FakeXHR.instances.push(this);
    this.sent = body;
    queueMicrotask(() => this.onload?.());
  }
}

/**
 * Render the UploadControl into jsdom with base props overridable per
 * test.
 *
 * @param props - prop overrides
 * @returns the container element holding the rendered control
 */
async function renderUpload(
  props: Partial<UploadControlProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: UploadControlProps = {
    folder: "",
    onUploaded: () => {},
  };
  await act(async () => {
    root.render(<UploadControl {...baseProps} {...props} />);
  });
  return container;
}

/**
 * Attach a file to the picker and fire the change event. React tracks
 * the input value with a private descriptor, so `files` is defined
 * directly and the event dispatched the way a browser pick would.
 *
 * @param container - the rendered control
 * @param fileName - the browser-side file name, used verbatim
 * @param content - the file content
 */
async function chooseFile(
  container: HTMLElement,
  fileName: string,
  content: string,
): Promise<void> {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  const file = new File([content], fileName, { type: "text/plain" });
  Object.defineProperty(input, "files", {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flushAsync();
}

/**
 * Drain the upload pipeline: the fetch stub, the client promise chain
 * and the XHR double all settle on microtasks and macrotasks that React's
 * `act` does not itself wait for, so yield once around a timer to let the
 * whole flow finish before asserting.
 */
async function flushAsync(): Promise<void> {
  // Yield once around a real timer: React's `act` does not itself wait
  // for the fetch/client/XHR promise chain, so let the event loop turn.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

// The component PUTs the file body via XHR; jsdom cannot open real
// sockets, so every test swaps in the recording double.
beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXHR.instances = [];
  document.body.innerHTML = "";
});

describe("UploadControl", () => {
  it("uploads into the own space by default (space: own)", async () => {
    const fetchMock = stubApi({
      "POST /api/files/upload-url": {
        status: 200,
        body: { url: "http://storage.local/presigned-put", key: "a.txt" },
      },
    });
    const container = await renderUpload();
    await chooseFile(container, "a.txt", "hello");

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/files/upload-url" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(
      (postCall as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      folder: "",
      fileName: "a.txt",
      overwrite: false,
      space: "own",
    });
    // The file body was PUT to the returned presigned URL.
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]?.url).toBe(
      "http://storage.local/presigned-put",
    );
    expect(container.textContent).toContain("Uploaded a.txt");
  });

  it("uploads in a shared space: the POST body carries the space and the file is PUT to the presigned URL (T027)", async () => {
    const fetchMock = stubApi({
      "POST /api/files/upload-url": {
        status: 200,
        body: { url: "http://storage.local/presigned-put", key: "notes.txt" },
      },
    });
    const onUploaded = vi.fn();
    const container = await renderUpload({
      folder: "",
      space: "shared:share-1",
      onUploaded,
    });
    await chooseFile(container, "notes.txt", "project notes v1\n");

    // The upload-url request carries the space so the server presigns
    // against the sharer's bucket + prefix (R2); the file key stays
    // mount-relative.
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/files/upload-url" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(
      (postCall as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).toEqual({
      folder: "",
      fileName: "notes.txt",
      overwrite: false,
      space: "shared:share-1",
    });
    // The file body was PUT to the returned presigned URL.
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]?.url).toBe(
      "http://storage.local/presigned-put",
    );
    expect(container.textContent).toContain("Uploaded notes.txt");
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation on a 409 in a shared space and retries with overwrite=true on Replace (T027)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        (url: string, init?: RequestInit): Promise<Response> => {
          if (init?.method === "POST" && url === "/api/files/upload-url") {
            const body = JSON.parse(init.body as string) as {
              overwrite: boolean;
            };
            if (!body.overwrite) {
              return Promise.resolve(
                jsonResponse(
                  {
                    error: 'A file named "notes.txt" already exists',
                    code: "already_exists",
                  },
                  409,
                ),
              );
            }
            return Promise.resolve(
              jsonResponse(
                { url: "http://storage.local/presigned-put", key: "notes.txt" },
                200,
              ),
            );
          }
          return Promise.reject(
            new Error(`Unhandled request: ${init?.method} ${url}`),
          );
        },
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const container = await renderUpload({ space: "shared:share-1" });

    // The first attempt (no overwrite consent) is refused with 409 and
    // the confirmation dialog appears (US3 sc.2, same flow as own space).
    await chooseFile(container, "notes.txt", "v1");
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("already exists");

    // Confirming retries with overwrite=true, still scoped to the space.
    const replaceButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Replace",
    );
    expect(replaceButton).toBeDefined();
    await act(async () => {
      replaceButton?.click();
    });
    await flushAsync();

    const posts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/files/upload-url" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(2);
    const retry = JSON.parse(
      (posts[1] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(retry).toEqual({
      folder: "",
      fileName: "notes.txt",
      overwrite: true,
      space: "shared:share-1",
    });
    // The replace completed: success feedback and a fresh presigned PUT.
    expect(container.textContent).toContain("Uploaded notes.txt");
    expect(FakeXHR.instances).toHaveLength(1);
  });
});
