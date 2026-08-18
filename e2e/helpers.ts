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
 * Enroll the first passkey via an invite link: open the register page with
 * the invite token and complete the registration ceremony. The passkey is
 * created on the account the invite targets (a new user, or an existing
 * account with matching scope when the invite attaches); the ceremony
 * signs the user in (US1, FR-001/FR-002). The username fallback form no
 * longer exists, so this is the only first-passkey enrollment path.
 *
 * @param page - the page
 * @param token - the invite token from the invite link
 */
export async function enrollViaInvite(
  page: Page,
  token: string,
): Promise<void> {
  await page.goto(`/register?token=${token}`);
  await page.getByRole("button", { name: "Create passkey" }).click();
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
