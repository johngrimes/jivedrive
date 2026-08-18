import { expect } from "@playwright/test";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";

/**
 * Enable a virtual WebAuthn authenticator on the page's context so passkey
 * ceremonies (create and get) complete without a real device.
 *
 * @param context - the browser context
 * @param page - the page
 * @returns the CDP session
 */
export async function enableVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return cdp;
}

/**
 * Fill in the username and submit the sign-in form.
 *
 * @param page - the page
 * @param username - the username to sign in as
 */
export async function signIn(page: Page, username: string): Promise<void> {
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
}

/**
 * Assert that the header shows the signed-in user. The username is the
 * sign-out button's label (the header redesign made the button itself the
 * sign-in state indicator).
 *
 * @param page - the page
 * @param username - the expected username
 */
export async function expectSignedInAs(
  page: Page,
  username: string,
): Promise<void> {
  await expect(
    page.getByRole("button", { name: username, exact: true }),
  ).toBeVisible();
}

/**
 * Sign out via the header button (labelled with the username) and wait for
 * the sign-in state.
 *
 * @param page - the page
 * @param username - the signed-in username shown on the sign-out button
 */
export async function signOut(page: Page, username: string): Promise<void> {
  await page.getByRole("button", { name: username, exact: true }).click();
  // The header flips back to the signed-out state: the "Sign in" link is
  // visible and the username button is gone.
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: username, exact: true }),
  ).toHaveCount(0);
}

/**
 * Assert that the page has no horizontal overflow at the current viewport.
 *
 * @param page - the page
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const hasOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
}

/**
 * Read a Playwright download stream to a Buffer.
 *
 * @param stream - the download's readable stream
 * @returns the concatenated bytes
 */
export async function readStream(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
