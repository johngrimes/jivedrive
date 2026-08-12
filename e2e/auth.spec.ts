import { expect, test } from "@playwright/test";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";

/**
 * Enable a virtual WebAuthn authenticator on the page's context so passkey
 * ceremonies (create and get) complete without a real device.
 *
 * @param context - the browser context
 * @param page - the page
 * @returns the CDP session
 */
async function enableVirtualAuthenticator(
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
async function signIn(page: Page, username: string): Promise<void> {
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Continue with passkey" }).click();
}

/**
 * Assert that the persistent header shows the signed-in user.
 *
 * @param page - the page
 * @param username - the expected username
 */
async function expectSignedInAs(page: Page, username: string): Promise<void> {
  await expect(page.locator(".app-session-user")).toHaveText(
    `Signed in as ${username}`,
  );
}

/**
 * Sign out via the header button and wait for the sign-in state.
 *
 * @param page - the page
 */
async function signOut(page: Page): Promise<void> {
  await page
    .locator(".app-session")
    .getByRole("button", { name: "Sign out" })
    .click();
  await expect(page.locator(".app-session")).toContainText("Sign in");
}

test("a seeded user signs in with a passkey and signs out", async ({
  page,
  context,
}) => {
  await enableVirtualAuthenticator(context, page);

  // First sign-in: the seeded user has no passkey, so one is created and
  // the user lands on the files page signed in.
  await page.goto("/");
  await signIn(page, "alice");
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "alice");

  // Sign out returns to the sign-in form.
  await signOut(page);
  await expect(page.getByLabel("Username")).toBeVisible();

  // Second sign-in uses the registered passkey (assertion ceremony).
  await signIn(page, "alice");
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "alice");

  await signOut(page);
});

test("an invitee registers a passkey from an invite link and signs in", async ({
  page,
  context,
}) => {
  await enableVirtualAuthenticator(context, page);

  // The register page claims the invite and shows the invite's username.
  await page.goto("/register?token=invite-carol");
  await expect(page.getByLabel("Your username")).toHaveValue("carol");
  await expect(page.getByText("Bucket: jivedrive-prod")).toBeVisible();

  // Creating the passkey signs the invitee in immediately.
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "carol");

  // Sign out, then sign in again with the newly registered passkey.
  await signOut(page);
  await signIn(page, "carol");
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "carol");
});

test("an expired invite is refused with a clear message", async ({ page }) => {
  await page.goto("/register?token=invite-dave-expired");
  await expect(page.getByText(/This invite has expired/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create passkey" }),
  ).toHaveCount(0);
});

test("sign-in page is usable at mobile, tablet and desktop widths", async ({
  page,
}) => {
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with passkey" }),
    ).toBeVisible();
    // No horizontal scrolling at any supported width.
    const hasHorizontalOverflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow, `overflow at ${viewport.width}px`).toBe(
      false,
    );
  }
});
