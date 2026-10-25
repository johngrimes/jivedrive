import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import type { SessionValue } from "../src/auth/sessionContext";
import { AppShell } from "../src/components/AppShell";

/** A signed-in session; `isAdmin` is set per test. */
function session(isAdmin: boolean): SessionValue {
  return {
    user: {
      id: "user-1",
      username: "alice",
      bucket: "jivedrive-prod",
      prefix: "users/alice/",
      isAdmin,
    },
    loading: false,
    refresh: async () => {},
    signOut: async () => {},
  };
}

/**
 * Render the AppShell around an empty routed page.
 *
 * @param value - the session value
 * @returns the container element holding the rendered shell
 */
async function renderShell(value: SessionValue): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/files"]}>
        <SessionContext.Provider value={value}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/files" element={<p>files</p>} />
            </Route>
          </Routes>
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AppShell", () => {
  it.each([false, true])(
    "shows the Settings link pointing to /settings (isAdmin=%s)",
    async (isAdmin) => {
      const container = await renderShell(session(isAdmin));

      const link = container.querySelector('header a[href="/settings"]');
      expect(link).not.toBeNull();
      expect(link?.getAttribute("aria-label")).toBe("Settings");
      expect(link?.className).toContain("min-h-11");
      // No nested interactive element inside the link.
      expect(link?.querySelector("button")).toBeNull();
      expect(container.querySelector('header a[href="/admin"]')).toBeNull();
    },
  );

  it("hides the Settings link when signed out", async () => {
    const container = await renderShell({
      user: null,
      loading: false,
      refresh: async () => {},
      signOut: async () => {},
    });

    expect(container.querySelector('a[href="/settings"]')).toBeNull();
  });
});
