import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import type { SessionValue } from "../src/auth/sessionContext";
import { SettingsPage } from "../src/pages/Settings";

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

/** A signed-in non-admin session. */
const memberSession: SessionValue = {
  user: {
    id: "user-1",
    username: "alice",
    bucket: "jivedrive-prod",
    prefix: "users/alice/",
    isAdmin: false,
  },
  loading: false,
  refresh: async () => {},
  signOut: async () => {},
};

/** A signed-in admin session. */
const adminSession: SessionValue = {
  ...memberSession,
  user: { ...memberSession.user!, isAdmin: true },
};

/** A stored credential as listed by the API. */
const storedKey = {
  accessKeyId: "AKIDSTORED0001",
  label: "Laptop",
  createdAt: "2026-10-20T09:30:00.000Z",
};

/** The rclone config the create response carries. */
const RCLONE_CONFIG = [
  "[jivedrive-s3]",
  "type = s3",
  "provider = Other",
  "endpoint = https://s3.example.test",
  "region = ca",
  "access_key_id = AKIDNEW0002",
  "secret_access_key = SECRETNEW0002",
  "no_check_bucket = true",
  "",
  "[jivedrive]",
  "type = alias",
  "remote = jivedrive-s3:jivedrive-prod/users/alice/",
  "",
].join("\n");

/** A successful create response. */
const createdBody = {
  credential: {
    accessKeyId: "AKIDNEW0002",
    label: "Desktop",
    createdAt: "2026-10-25T10:00:00.000Z",
  },
  secretAccessKey: "SECRETNEW0002",
  rcloneConfig: RCLONE_CONFIG,
  endpoint: "https://s3.example.test",
  region: "ca",
  bucket: "jivedrive-prod",
  prefix: "users/alice/",
};

/** A stubbed API route: a JSON body (null for an empty body) and status. */
interface StubRoute {
  body: unknown;
  status: number;
}

/** A dynamic route handler, for deferred responses and network errors. */
type RouteHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

/**
 * Stub global fetch to serve the sync-credentials API. Routes are keyed by
 * "METHOD url"; each call gets a fresh Response.
 *
 * @param routes - the stubbed routes
 * @returns the fetch mock for assertions
 */
function stubSyncApi(routes: Record<string, StubRoute | RouteHandler>): Mock {
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
        if (route.body === null) {
          return Promise.resolve(new Response(null, { status: route.status }));
        }
        return Promise.resolve(jsonResponse(route.body, route.status));
      },
    );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** A GET route listing the given credentials with the feature enabled. */
function listRoute(credentials: unknown[] = []): StubRoute {
  return { status: 200, body: { enabled: true, credentials, limit: 10 } };
}

/**
 * Render the SettingsPage into jsdom.
 *
 * @param session - the session value
 * @returns the container element holding the rendered page
 */
async function renderSettings(
  session: SessionValue = memberSession,
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionContext.Provider value={session}>
          <SettingsPage />
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  return container;
}

/**
 * Set an input's value the way a keystroke would (React tracks the native
 * setter) and fire the input event.
 *
 * @param input - the input element
 * @param value - the new value
 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The key label input. */
function labelInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector(
    "#sync-key-label",
  ) as HTMLInputElement | null;
  if (!input) throw new Error("label input not found");
  return input;
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

/** The create-key submit button (its label reads "Creating..." in flight). */
function createButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector(
    'form button[type="submit"]',
  ) as HTMLButtonElement | null;
  if (!found) throw new Error("create button not found");
  return found;
}

/**
 * Type a label and submit the create form.
 *
 * @param container - the rendered page
 * @param label - the label to type
 */
async function createKey(container: HTMLElement, label: string): Promise<void> {
  await typeInto(labelInput(container), label);
  await act(async () => {
    createButton(container).click();
  });
}

let writeText: Mock;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SettingsPage", () => {
  it("says rclone sync is not enabled when the server has it disabled", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": {
        status: 200,
        body: { enabled: false, credentials: [], limit: 10 },
      },
    });
    const container = await renderSettings();

    expect(container.textContent).toContain("Sync with rclone");
    expect(container.textContent).toContain(
      "rclone sync is not enabled on this server.",
    );
    expect(container.querySelector("#sync-key-label")).toBeNull();
  });

  it("shows the explanation, its limitations and an empty list", async () => {
    stubSyncApi({ "GET /api/sync-credentials": listRoute() });
    const container = await renderSettings();

    const text = container.textContent ?? "";
    expect(text).toContain("Folders shared with you are not included");
    expect(text).toContain("after the next background scan");
    expect(text).toContain("breaks share links");
    expect(text).toContain("No sync keys yet.");
    expect(container.querySelector('table[aria-label="Sync keys"]')).toBeNull();
  });

  it("lists each key with its label, access key ID and created date", async () => {
    stubSyncApi({ "GET /api/sync-credentials": listRoute([storedKey]) });
    const container = await renderSettings();

    const table = container.querySelector('table[aria-label="Sync keys"]');
    expect(table).not.toBeNull();
    const row = table?.querySelector("tbody tr");
    expect(row?.textContent).toContain("Laptop");
    expect(row?.textContent).toContain("AKIDSTORED0001");
    expect(row?.textContent).toMatch(/2026-10-2\d \d{2}:\d{2}/);
  });

  it("refuses an empty or over-long label without sending a request", async () => {
    const fetchMock = stubSyncApi({ "GET /api/sync-credentials": listRoute() });
    const container = await renderSettings();

    await createKey(container, "   ");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Enter a label",
    );

    await createKey(container, "x".repeat(65));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "64 characters",
    );

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });

  it("shows progress while creating, then the one-time panel with copy controls", async () => {
    const { promise: pending, resolve: resolveCreate } =
      Promise.withResolvers<Response>();
    const fetchMock = stubSyncApi({
      "GET /api/sync-credentials": listRoute(),
      "POST /api/sync-credentials": () => pending,
    });
    const container = await renderSettings();

    await createKey(container, "  Desktop  ");

    // In flight: the button is disabled and says so.
    expect(createButton(container).disabled).toBe(true);
    expect(createButton(container).textContent).toContain("Creating...");

    // The label was trimmed before sending.
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      label: "Desktop",
    });

    await act(async () => {
      resolveCreate(jsonResponse(createdBody, 201));
    });

    const panel = container.querySelector(
      'section[aria-label="New sync key"]',
    ) as HTMLElement | null;
    expect(panel).not.toBeNull();
    const panelText = panel?.textContent ?? "";
    expect(panelText).toContain("won't be shown again");
    expect(panelText).toContain("up to about a minute");
    expect(
      panel?.querySelector('[aria-label="rclone config"]')?.textContent,
    ).toBe(RCLONE_CONFIG);
    expect(panelText).toContain("rclone sync jivedrive: ~/JiveDrive");
    expect(panelText).toContain(
      "mkdir -p ~/JiveDrive && rclone bisync jivedrive: ~/JiveDrive --resync",
    );
    for (const value of [
      "AKIDNEW0002",
      "SECRETNEW0002",
      "https://s3.example.test",
      "ca",
      "jivedrive-prod",
      "users/alice/",
    ]) {
      expect(panelText).toContain(value);
    }

    // Every block and raw value has its own copy control.
    const copies: Array<[string, string]> = [
      ["Copy rclone config", RCLONE_CONFIG],
      ["Copy sync command", "rclone sync jivedrive: ~/JiveDrive"],
      [
        "Copy bisync command",
        "mkdir -p ~/JiveDrive && rclone bisync jivedrive: ~/JiveDrive --resync",
      ],
      ["Copy access key ID", "AKIDNEW0002"],
      ["Copy secret access key", "SECRETNEW0002"],
      ["Copy endpoint", "https://s3.example.test"],
      ["Copy region", "ca"],
      ["Copy bucket", "jivedrive-prod"],
      ["Copy prefix", "users/alice/"],
    ];
    for (const [name, value] of copies) {
      const copy = button(panel!, name);
      expect(copy, name).toBeDefined();
      await act(async () => {
        copy?.click();
      });
      expect(writeText).toHaveBeenLastCalledWith(value);
    }
    expect(container.textContent).toContain("Copied to clipboard");

    // The new key also appears in the list, and the label input is cleared.
    const table = container.querySelector('table[aria-label="Sync keys"]');
    expect(table?.textContent).toContain("Desktop");
    expect(labelInput(container).value).toBe("");
  });

  it("scrolls the new key panel into view and focuses its heading", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": listRoute(),
      "POST /api/sync-credentials": { status: 201, body: createdBody },
    });
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const container = await renderSettings();
    await createKey(container, "Desktop");

    const heading = container.querySelector(
      'section[aria-label="New sync key"] h3',
    ) as HTMLElement | null;
    expect(heading).not.toBeNull();
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    expect(scrollSpy.mock.contexts).toContain(heading);
    scrollSpy.mockRestore();
  });

  it("hides the secret for good once the panel is dismissed", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": listRoute(),
      "POST /api/sync-credentials": { status: 201, body: createdBody },
    });
    const container = await renderSettings();
    await createKey(container, "Desktop");
    expect(container.textContent).toContain("SECRETNEW0002");

    const dismiss = button(container, "I've saved it");
    expect(dismiss).toBeDefined();
    await act(async () => {
      dismiss?.click();
    });

    expect(container.textContent).not.toContain("SECRETNEW0002");
    expect(
      container.querySelector('section[aria-label="New sync key"]'),
    ).toBeNull();
    // The key itself stays listed.
    expect(
      container.querySelector('table[aria-label="Sync keys"]')?.textContent,
    ).toContain("AKIDNEW0002");
  });

  it.each([
    [
      409,
      { error: "Key limit reached", code: "credential_limit" },
      "You already have the maximum of 10 sync keys",
    ],
    [
      409,
      { error: "Unsupported prefix", code: "unsupported_prefix" },
      "can't be issued for your storage location",
    ],
    [
      502,
      {
        error: "The storage provider failed: injected",
        code: "storage_provider_error",
      },
      "The storage provider failed: injected",
    ],
  ])(
    "surfaces a %i %o error from key creation",
    async (status, body, expected) => {
      stubSyncApi({
        "GET /api/sync-credentials": listRoute(),
        "POST /api/sync-credentials": { status, body },
      });
      const container = await renderSettings();
      await createKey(container, "Desktop");

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(expected);
      expect(
        container.querySelector('section[aria-label="New sync key"]'),
      ).toBeNull();
      expect(createButton(container).disabled).toBe(false);
    },
  );

  it("surfaces a network failure from key creation", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": listRoute(),
      "POST /api/sync-credentials": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const container = await renderSettings();
    await createKey(container, "Desktop");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach the server",
    );
  });

  it("surfaces a failure to load the key list", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const container = await renderSettings();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not reach the server",
    );
  });

  it("disables key creation at the limit and says why", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => ({
      accessKeyId: `AKID${i}`,
      label: `Key ${i}`,
      createdAt: "2026-10-20T09:30:00.000Z",
    }));
    stubSyncApi({ "GET /api/sync-credentials": listRoute(keys) });
    const container = await renderSettings();

    expect(createButton(container).disabled).toBe(true);
    expect(container.textContent).toContain("Revoke one to create another");
  });

  it("revokes a key after confirmation, with progress and a success notice", async () => {
    const { promise: pending, resolve: resolveDelete } =
      Promise.withResolvers<Response>();
    const fetchMock = stubSyncApi({
      "GET /api/sync-credentials": listRoute([storedKey]),
      "DELETE /api/sync-credentials/AKIDSTORED0001": () => pending,
    });
    const container = await renderSettings();

    await act(async () => {
      button(container, "Revoke key Laptop")?.click();
    });
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Laptop");
    expect(dialog?.textContent).toContain("stops working within a few minutes");
    // Nothing is sent before confirming.
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toHaveLength(0);

    await act(async () => {
      button(dialog!, "Revoke key")?.click();
    });
    const inFlight = button(
      container.querySelector('[role="alertdialog"]')!,
      "Revoke key",
    );
    expect(inFlight?.disabled).toBe(true);
    expect(inFlight?.textContent).toContain("Revoking...");

    await act(async () => {
      resolveDelete(new Response(null, { status: 204 }));
    });

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Revoked key "Laptop". It will stop working within a few minutes.',
    );
    expect(container.querySelector('table[aria-label="Sync keys"]')).toBeNull();
    expect(container.textContent).toContain("No sync keys yet.");
  });

  it("cancelling the revoke confirmation sends nothing", async () => {
    const fetchMock = stubSyncApi({
      "GET /api/sync-credentials": listRoute([storedKey]),
    });
    const container = await renderSettings();

    await act(async () => {
      button(container, "Revoke key Laptop")?.click();
    });
    await act(async () => {
      button(
        container.querySelector('[role="alertdialog"]')!,
        "Cancel",
      )?.click();
    });

    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('table[aria-label="Sync keys"]')?.textContent,
    ).toContain("Laptop");
  });

  it("keeps the key and shows the error when revoking fails", async () => {
    stubSyncApi({
      "GET /api/sync-credentials": listRoute([storedKey]),
      "DELETE /api/sync-credentials/AKIDSTORED0001": {
        status: 502,
        body: {
          error: "The storage provider failed: boom",
          code: "storage_provider_error",
        },
      },
    });
    const container = await renderSettings();

    await act(async () => {
      button(container, "Revoke key Laptop")?.click();
    });
    await act(async () => {
      button(
        container.querySelector('[role="alertdialog"]')!,
        "Revoke key",
      )?.click();
    });

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
      "The storage provider failed: boom",
    );
    expect(
      container.querySelector('table[aria-label="Sync keys"]')?.textContent,
    ).toContain("Laptop");
  });

  it("shows the Manage users link to admins only", async () => {
    stubSyncApi({ "GET /api/sync-credentials": listRoute() });
    const member = await renderSettings(memberSession);
    expect(member.querySelector('a[href="/admin"]')).toBeNull();
    document.body.innerHTML = "";

    const admin = await renderSettings(adminSession);
    const link = admin.querySelector('a[href="/admin"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("Manage users");
  });
});
