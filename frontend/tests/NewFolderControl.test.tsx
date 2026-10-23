import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NewFolderControl } from "../src/components/NewFolderControl";
import type { NewFolderControlProps } from "../src/components/NewFolderControl";

/**
 * Build a JSON response for the fetch stub.
 *
 * @param body - payload
 * @param status - HTTP status
 * @returns a Response carrying the JSON body
 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stub global fetch so every POST /api/files/folders answers with the
 * given status and body; any other request fails the test.
 *
 * @param status - HTTP status of the response
 * @param body - JSON response body
 * @returns the fetch mock for assertions
 */
function stubCreateFolder(status: number, body: unknown): Mock {
  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/files/folders" && init?.method === "POST"
        ? Promise.resolve(jsonResponse(body, status))
        : Promise.reject(new Error(`Unhandled request: ${url}`)),
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/**
 * Render the control into jsdom with base props overridable per test.
 *
 * @param props - prop overrides
 * @returns the container element
 */
async function renderControl(
  props: Partial<NewFolderControlProps> = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const baseProps: NewFolderControlProps = {
    folder: "",
    onCreated: () => {},
  };
  await act(async () => {
    root.render(<NewFolderControl {...baseProps} {...props} />);
  });
  return container;
}

/** Find a button by its trimmed text content. */
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

/** The folder name input inside the open dialog. */
function nameInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Folder name"]',
  );
  if (!input) throw new Error("No folder name input");
  return input;
}

/** Open the dialog via the toolbar button. */
async function openDialog(container: HTMLElement): Promise<void> {
  await act(async () => {
    button(container, "New folder").click();
  });
}

/**
 * Type into a React-controlled input: set the value through the native
 * setter so React's change tracking sees it, then dispatch input.
 */
async function typeName(container: HTMLElement, value: string): Promise<void> {
  const input = nameInput(container);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Submit the dialog's form (Enter or the Create button). */
async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    button(container, "Create").click();
  });
  // Drain the fetch/client promise chain, which `act` does not wait for.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** The dialog element, or null when closed. */
function dialog(container: HTMLElement): Element | null {
  return container.querySelector('[role="dialog"]');
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("NewFolderControl", () => {
  it("opens a dialog whose Create action needs a non-blank name", async () => {
    const container = await renderControl();
    expect(dialog(container)).toBeNull();

    await openDialog(container);

    expect(dialog(container)).not.toBeNull();
    expect(document.activeElement).toBe(nameInput(container));
    expect(button(container, "Create").disabled).toBe(true);
    await typeName(container, "   ");
    expect(button(container, "Create").disabled).toBe(true);
    await typeName(container, "Reports");
    expect(button(container, "Create").disabled).toBe(false);
  });

  it("creates the folder in the current folder, closes, and reports success", async () => {
    const onCreated = vi.fn();
    const fetchMock = stubCreateFolder(201, {
      name: "Reports",
      prefix: "docs/Reports/",
    });
    const container = await renderControl({ folder: "docs/", onCreated });

    await openDialog(container);
    await typeName(container, "Reports");
    await submit(container);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      folder: "docs/",
      name: "Reports",
      space: "own",
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(dialog(container)).toBeNull();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Created folder "Reports"');
  });

  it("creates the folder inside a shared space", async () => {
    const fetchMock = stubCreateFolder(201, {
      name: "drafts",
      prefix: "drafts/",
    });
    const container = await renderControl({ space: "shared:share-1" });

    await openDialog(container);
    await typeName(container, "drafts");
    await submit(container);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      space: "shared:share-1",
      name: "drafts",
    });
  });

  it("keeps the dialog open with the server's error when the name is taken", async () => {
    const onCreated = vi.fn();
    stubCreateFolder(409, {
      error: 'A folder named "docs" already exists',
      code: "already_exists",
    });
    const container = await renderControl({ onCreated });

    await openDialog(container);
    await typeName(container, "docs");
    await submit(container);

    expect(dialog(container)).not.toBeNull();
    const alert = dialog(container)?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'A folder named "docs" already exists',
    );
    // The name stays so it can be corrected, and the action is re-enabled.
    expect(nameInput(container).value).toBe("docs");
    expect(button(container, "Create").disabled).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows a pending state while the request is in flight", async () => {
    const { promise, resolve: respond } = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(promise) as unknown as typeof fetch,
    );
    const container = await renderControl();

    await openDialog(container);
    await typeName(container, "Reports");
    await act(async () => {
      button(container, "Create").click();
    });

    const pending = button(container, "Creating...");
    expect(pending.disabled).toBe(true);
    expect(button(container, "Cancel").disabled).toBe(true);
    expect(nameInput(container).disabled).toBe(true);

    await act(async () => {
      respond(jsonResponse({ name: "Reports", prefix: "Reports/" }, 201));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog(container)).toBeNull();
  });

  it("cancels without sending a request", async () => {
    const fetchMock = stubCreateFolder(201, {});
    const container = await renderControl();

    await openDialog(container);
    await typeName(container, "Reports");
    await act(async () => {
      button(container, "Cancel").click();
    });

    expect(dialog(container)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-prompts sign-in when the session has expired", async () => {
    const onSessionExpired = vi.fn();
    stubCreateFolder(401, { error: "Not signed in", code: "unauthorized" });
    const container = await renderControl({ onSessionExpired });

    await openDialog(container);
    await typeName(container, "Reports");
    await submit(container);

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
