import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SessionContext } from "../src/auth/sessionContext";
import { SignIn } from "../src/pages/SignIn";

/**
 * Render the SignIn page into jsdom with a signed-out session and a router.
 *
 * The session value is mocked (user null, not loading) so the page renders
 * its signed-out state without any network call; the passkey ceremony is
 * never triggered in these tests.
 *
 * @returns the container element holding the rendered page
 */
async function renderSignIn(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SessionContext.Provider
          value={{
            user: null,
            loading: false,
            refresh: async () => {},
            signOut: async () => {},
          }}
        >
          <SignIn />
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  return container;
}

describe("SignIn", () => {
  it("renders the passkey sign-in button and no register link (T016)", async () => {
    const container = await renderSignIn();

    const passkeyButton = container.querySelector(
      'button[type="button"]',
    ) as HTMLButtonElement | null;
    expect(passkeyButton).not.toBeNull();
    expect(passkeyButton?.textContent).toContain("Sign in with passkey");

    // Registration is token-gated and happens via a full invite link, so
    // the sign-in page offers no in-page register path (FR-001).
    expect(container.querySelector('a[href="/register"]')).toBeNull();
  });

  it("renders no username input and no username fallback form (T016)", async () => {
    const container = await renderSignIn();

    // The username-first flow is gone (FR-001/FR-002): no text input, no
    // "First time?" hint, no Create passkey button on the sign-in page.
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector("#username")).toBeNull();
    expect(container.textContent).not.toContain(
      "First time? Use your username",
    );
    expect(container.textContent).not.toContain("Create passkey");
  });
});
