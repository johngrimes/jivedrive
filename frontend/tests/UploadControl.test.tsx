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

/** The parsed body of a POST /api/files/upload-url request. */
interface UploadUrlRequest {
  folder: string;
  fileName: string;
  overwrite: boolean;
  space: string;
}

/**
 * Stub the upload-url endpoint the way the backend behaves for a batch:
 * each file name gets its own presigned URL, names in `existing` are
 * refused with 409 until overwrite consent is given, and names in
 * `expired` answer 401 as if the session ran out mid-batch.
 *
 * @param options - the names that already exist or hit an expired session
 * @returns the fetch mock for assertions
 */
function stubUploadApi(
  options: { existing?: string[]; expired?: string[] } = {},
): Mock {
  const existing = new Set(options.existing ?? []);
  const expired = new Set(options.expired ?? []);
  const fetchMock = vi
    .fn()
    .mockImplementation(
      (url: string, init?: RequestInit): Promise<Response> => {
        if (init?.method !== "POST" || url !== "/api/files/upload-url") {
          return Promise.reject(
            new Error(`Unhandled request: ${init?.method} ${url}`),
          );
        }
        const body = JSON.parse(init.body as string) as UploadUrlRequest;
        if (expired.has(body.fileName)) {
          return Promise.resolve(
            jsonResponse({ error: "Not signed in", code: "unauthorized" }, 401),
          );
        }
        if (existing.has(body.fileName) && !body.overwrite) {
          return Promise.resolve(
            jsonResponse(
              {
                error: `A file named "${body.fileName}" already exists`,
                code: "already_exists",
              },
              409,
            ),
          );
        }
        return Promise.resolve(
          jsonResponse({
            url: `http://storage.local/${body.fileName}`,
            key: body.fileName,
          }),
        );
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * The upload-url request bodies the control sent, in order.
 *
 * @param fetchMock - the fetch mock
 * @returns the parsed request bodies
 */
function uploadRequests(fetchMock: Mock): UploadUrlRequest[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        url === "/api/files/upload-url" &&
        (init as RequestInit | undefined)?.method === "POST",
    )
    .map(
      ([, init]) =>
        JSON.parse((init as RequestInit).body as string) as UploadUrlRequest,
    );
}

/**
 * A minimal XMLHttpRequest double: the component PUTs the file body to
 * the presigned URL via XHR, and jsdom cannot open real network sockets.
 * Records every instance so tests can assert the target URL. By default
 * each PUT resolves immediately with the status `statusFor` gives its
 * URL; with `hold` set, PUTs stay in flight until `complete()` is called.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  static statusFor: (url: string) => number = () => 200;
  static hold = false;
  status = 200;
  url = "";
  sent: unknown = null;
  upload: {
    onprogress:
      | ((event: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null;
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
    this.status = FakeXHR.statusFor(this.url);
    if (!FakeXHR.hold) queueMicrotask(() => this.onload?.());
  }

  complete(): void {
    this.onload?.();
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
 * The control's file input.
 *
 * @param container - the rendered control
 * @returns the file input
 */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

/**
 * Attach files to the picker and fire the change event. React tracks
 * the input value with a private descriptor, so `files` is defined
 * directly and the event dispatched the way a browser pick would.
 *
 * @param container - the rendered control
 * @param names - the browser-side file names, used verbatim, in pick order
 */
async function chooseFiles(
  container: HTMLElement,
  names: string[],
): Promise<void> {
  const input = fileInput(container);
  const files = names.map(
    (name) => new File([`content of ${name}`], name, { type: "text/plain" }),
  );
  Object.defineProperty(input, "files", {
    value: files,
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

/**
 * The open overwrite confirmation dialog, or null.
 *
 * @param container - the rendered control
 * @returns the dialog element
 */
function dialog(container: HTMLElement): Element | null {
  return container.querySelector('[role="alertdialog"]');
}

/**
 * Click a button by its visible text and let the batch move on.
 *
 * @param container - the rendered control
 * @param label - the button's text
 */
async function clickButton(
  container: HTMLElement,
  label: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  await flushAsync();
}

/**
 * Tick the dialog's "Apply to remaining conflicts" checkbox.
 *
 * @param container - the rendered control
 */
async function applyToRemaining(container: HTMLElement): Promise<void> {
  const checkbox = dialog(container)?.querySelector(
    'input[type="checkbox"]',
  ) as HTMLInputElement | null;
  expect(checkbox).not.toBeNull();
  await act(async () => {
    checkbox?.click();
  });
}

/**
 * Text of the visible feedback with the given role.
 *
 * @param container - the rendered control
 * @param role - "status" or "alert"
 * @returns the element's text, or null when absent
 */
function feedback(
  container: HTMLElement,
  role: "status" | "alert",
): string | null {
  return container.querySelector(`[role="${role}"]`)?.textContent ?? null;
}

// The component PUTs the file body via XHR; jsdom cannot open real
// sockets, so every test swaps in the recording double.
beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXHR.instances = [];
  FakeXHR.statusFor = () => 200;
  FakeXHR.hold = false;
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
    await chooseFiles(container, ["a.txt"]);

    expect(uploadRequests(fetchMock)).toEqual([
      { folder: "", fileName: "a.txt", overwrite: false, space: "own" },
    ]);
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
    await chooseFiles(container, ["notes.txt"]);

    // The upload-url request carries the space so the server presigns
    // against the sharer's bucket + prefix (R2); the file key stays
    // mount-relative.
    expect(uploadRequests(fetchMock)).toEqual([
      {
        folder: "",
        fileName: "notes.txt",
        overwrite: false,
        space: "shared:share-1",
      },
    ]);
    // The file body was PUT to the returned presigned URL.
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]?.url).toBe(
      "http://storage.local/presigned-put",
    );
    expect(container.textContent).toContain("Uploaded notes.txt");
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation on a 409 in a shared space and retries with overwrite=true on Replace (T027)", async () => {
    const fetchMock = stubUploadApi({ existing: ["notes.txt"] });
    const container = await renderUpload({ space: "shared:share-1" });

    // The first attempt (no overwrite consent) is refused with 409 and
    // the confirmation dialog appears (US3 sc.2, same flow as own space).
    await chooseFiles(container, ["notes.txt"]);
    expect(dialog(container)?.textContent).toContain("already exists");

    // Confirming retries with overwrite=true, still scoped to the space.
    await clickButton(container, "Replace");

    expect(uploadRequests(fetchMock)).toEqual([
      {
        folder: "",
        fileName: "notes.txt",
        overwrite: false,
        space: "shared:share-1",
      },
      {
        folder: "",
        fileName: "notes.txt",
        overwrite: true,
        space: "shared:share-1",
      },
    ]);
    // The replace completed: success feedback and a fresh presigned PUT.
    expect(container.textContent).toContain("Uploaded notes.txt");
    expect(FakeXHR.instances).toHaveLength(1);
  });

  it("labels a single-file upload without a batch counter", async () => {
    stubUploadApi();
    FakeXHR.hold = true;
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt"]);

    expect(feedback(container, "status")).toBe("Uploading a.txt... 0%");
  });

  it("offers a multi-select picker", async () => {
    const container = await renderUpload();
    expect(fileInput(container).multiple).toBe(true);
    expect(container.textContent).toContain("Upload files");
  });

  it("uploads the selected files one at a time in selection order, counting through the batch", async () => {
    const fetchMock = stubUploadApi();
    FakeXHR.hold = true;
    const onUploaded = vi.fn();
    const container = await renderUpload({ folder: "docs/", onUploaded });
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt"]);

    // Only the first file is in flight; the picker is locked meanwhile.
    expect(uploadRequests(fetchMock).map((r) => r.fileName)).toEqual(["a.txt"]);
    expect(FakeXHR.instances).toHaveLength(1);
    expect(fileInput(container).disabled).toBe(true);
    expect(feedback(container, "status")).toContain(
      "Uploading a.txt (1 of 3)... 0%",
    );

    // Progress of the file in flight is reported with the batch counter.
    await act(async () => {
      FakeXHR.instances[0]?.upload.onprogress?.({
        lengthComputable: true,
        loaded: 1,
        total: 2,
      });
    });
    expect(feedback(container, "status")).toContain(
      "Uploading a.txt (1 of 3)... 50%",
    );

    // The next file starts only once the previous PUT has completed.
    FakeXHR.instances[0]?.complete();
    await flushAsync();
    expect(uploadRequests(fetchMock).map((r) => r.fileName)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(feedback(container, "status")).toContain(
      "Uploading b.txt (2 of 3)... 0%",
    );
    expect(onUploaded).not.toHaveBeenCalled();

    FakeXHR.instances[1]?.complete();
    await flushAsync();
    expect(feedback(container, "status")).toContain(
      "Uploading c.txt (3 of 3)... 0%",
    );
    FakeXHR.instances[2]?.complete();
    await flushAsync();

    expect(FakeXHR.instances.map((xhr) => xhr.url)).toEqual([
      "http://storage.local/a.txt",
      "http://storage.local/b.txt",
      "http://storage.local/c.txt",
    ]);
    expect(uploadRequests(fetchMock).every((r) => r.folder === "docs/")).toBe(
      true,
    );
    expect(feedback(container, "status")).toBe("Uploaded 3 files");
    expect(fileInput(container).disabled).toBe(false);
    // The listing refreshes once, after the whole batch.
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a failed file and lists each failure in the summary", async () => {
    const fetchMock = stubUploadApi();
    FakeXHR.statusFor = (url) =>
      url.endsWith("/b.txt") || url.endsWith("/d.txt") ? 500 : 200;
    const onUploaded = vi.fn();
    const container = await renderUpload({ onUploaded });
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt", "d.txt"]);

    expect(uploadRequests(fetchMock)).toHaveLength(4);
    const alert = feedback(container, "alert");
    expect(alert).toContain("Uploaded 2 of 4 files");
    expect(alert).toContain('Could not upload "b.txt"');
    expect(alert).toContain('Could not upload "d.txt"');
    expect(alert).not.toContain('"a.txt"');
    expect(feedback(container, "status")).toBeNull();
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("reports a failure to obtain an upload URL against the file and carries on", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        (_url: string, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(init?.body as string) as UploadUrlRequest;
          if (body.fileName === "a.txt") {
            return Promise.resolve(
              jsonResponse({ error: "Storage is unavailable" }, 502),
            );
          }
          return Promise.resolve(
            jsonResponse({ url: "http://storage.local/b.txt", key: "b.txt" }),
          );
        },
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt", "b.txt"]);

    const alert = feedback(container, "alert");
    expect(alert).toContain("Uploaded 1 of 2 files");
    expect(alert).toContain('Could not upload "a.txt". Storage is unavailable');
    expect(FakeXHR.instances.map((xhr) => xhr.url)).toEqual([
      "http://storage.local/b.txt",
    ]);
  });

  it("does not refresh the listing when nothing in the batch uploaded", async () => {
    stubUploadApi();
    FakeXHR.statusFor = () => 500;
    const onUploaded = vi.fn();
    const container = await renderUpload({ onUploaded });
    await chooseFiles(container, ["a.txt", "b.txt"]);

    const alert = feedback(container, "alert");
    expect(alert).toContain("Uploaded 0 of 2 files");
    expect(alert).toContain('Could not upload "a.txt"');
    expect(alert).toContain('Could not upload "b.txt"');
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("pauses on each conflict: Skip skips only that file and the next conflict asks again", async () => {
    const fetchMock = stubUploadApi({ existing: ["a.txt", "b.txt"] });
    const onUploaded = vi.fn();
    const container = await renderUpload({ onUploaded });
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt"]);

    expect(dialog(container)?.textContent).toContain(
      'A file named "a.txt" already exists',
    );
    // The batch waits for the answer and the picker stays locked.
    expect(uploadRequests(fetchMock)).toHaveLength(1);
    expect(fileInput(container).disabled).toBe(true);
    await clickButton(container, "Skip");

    expect(dialog(container)?.textContent).toContain(
      'A file named "b.txt" already exists',
    );
    await clickButton(container, "Replace");

    expect(dialog(container)).toBeNull();
    expect(
      uploadRequests(fetchMock).map((r) => [r.fileName, r.overwrite]),
    ).toEqual([
      ["a.txt", false],
      ["b.txt", false],
      ["b.txt", true],
      ["c.txt", false],
    ]);
    expect(FakeXHR.instances.map((xhr) => xhr.url)).toEqual([
      "http://storage.local/b.txt",
      "http://storage.local/c.txt",
    ]);
    expect(feedback(container, "status")).toBe("Uploaded 2 files, skipped 1");
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("closing the conflict dialog via the backdrop skips the file", async () => {
    stubUploadApi({ existing: ["a.txt"] });
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt", "b.txt"]);

    const backdrop = container.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement | null;
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop?.click();
    });
    await flushAsync();

    expect(dialog(container)).toBeNull();
    expect(FakeXHR.instances.map((xhr) => xhr.url)).toEqual([
      "http://storage.local/b.txt",
    ]);
    expect(feedback(container, "status")).toBe("Uploaded 1 file, skipped 1");
  });

  it("Replace with 'Apply to remaining conflicts' replaces later conflicts without asking", async () => {
    const fetchMock = stubUploadApi({ existing: ["a.txt", "b.txt", "c.txt"] });
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt", "d.txt"]);

    await applyToRemaining(container);
    await clickButton(container, "Replace");

    expect(dialog(container)).toBeNull();
    expect(
      uploadRequests(fetchMock).map((r) => [r.fileName, r.overwrite]),
    ).toEqual([
      ["a.txt", false],
      ["a.txt", true],
      ["b.txt", false],
      ["b.txt", true],
      ["c.txt", false],
      ["c.txt", true],
      ["d.txt", false],
    ]);
    expect(feedback(container, "status")).toBe("Uploaded 4 files");
  });

  it("Skip with 'Apply to remaining conflicts' skips later conflicts without asking", async () => {
    const fetchMock = stubUploadApi({ existing: ["a.txt", "b.txt"] });
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt"]);

    await applyToRemaining(container);
    await clickButton(container, "Skip");

    expect(dialog(container)).toBeNull();
    expect(
      uploadRequests(fetchMock).map((r) => [r.fileName, r.overwrite]),
    ).toEqual([
      ["a.txt", false],
      ["b.txt", false],
      ["c.txt", false],
    ]);
    expect(feedback(container, "status")).toBe("Uploaded 1 file, skipped 2");
  });

  it("a fresh batch asks again even after 'Apply to remaining conflicts'", async () => {
    stubUploadApi({ existing: ["a.txt", "b.txt"] });
    const container = await renderUpload();
    await chooseFiles(container, ["a.txt", "b.txt"]);
    await applyToRemaining(container);
    await clickButton(container, "Skip");
    expect(feedback(container, "status")).toBe("Skipped 2 files");

    await chooseFiles(container, ["a.txt"]);
    expect(dialog(container)?.textContent).toContain("a.txt");
  });

  it("offers 'Apply to remaining conflicts' only while later files remain", async () => {
    stubUploadApi({ existing: ["a.txt", "b.txt"] });
    const container = await renderUpload();

    // A single-file upload has nothing to apply the answer to.
    await chooseFiles(container, ["a.txt"]);
    expect(dialog(container)?.querySelector('input[type="checkbox"]')).toBe(
      null,
    );
    await clickButton(container, "Skip");
    expect(feedback(container, "status")).toBe("Skipped a.txt");

    // Nor does the conflict on the last file of a batch.
    await chooseFiles(container, ["c.txt", "b.txt"]);
    expect(dialog(container)?.textContent).toContain("b.txt");
    expect(dialog(container)?.querySelector('input[type="checkbox"]')).toBe(
      null,
    );
  });

  it("stops the batch when the session expires and reports what was uploaded", async () => {
    const fetchMock = stubUploadApi({ expired: ["b.txt"] });
    const onUploaded = vi.fn();
    const onSessionExpired = vi.fn();
    const container = await renderUpload({ onUploaded, onSessionExpired });
    await chooseFiles(container, ["a.txt", "b.txt", "c.txt"]);

    // c.txt is never attempted.
    expect(uploadRequests(fetchMock).map((r) => r.fileName)).toEqual([
      "a.txt",
      "b.txt",
    ]);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    const alert = feedback(container, "alert");
    expect(alert).toContain("Uploaded 1 of 3 files");
    expect(alert).toContain("Your session has expired. Please sign in again.");
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
});
