import { expect, test } from "@playwright/test";
import {
  enableVirtualAuthenticator,
  expectSignedInAs,
  signIn,
  signOut,
} from "./helpers";

test("a seeded user signs in with a passkey and signs out", async ({
  page,
  context,
}) => {
  await enableVirtualAuthenticator(context, page);

  // First sign-in: the seeded user has no passkey, so the fallback form
  // bootstraps their first (discoverable) passkey and the user lands on
  // the files page signed in.
  await page.goto("/");
  await signIn(page, "alice");
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "alice");

  // Sign out returns to the sign-in page.
  await signOut(page, "alice");

  // Second sign-in is username-less: one click on the primary button, zero
  // keystrokes anywhere, and the assertion ceremony signs the returning
  // user back in (US1 scenario 1, FR-001/FR-002).
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "alice");

  await signOut(page, "alice");
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

  // Sign out returns to the sign-in page.
  await signOut(page, "carol");

  // The passkey registered through the invite is discoverable (FR-007), so
  // the invitee signs back in username-less: one click on the primary
  // button, zero keystrokes (US3 scenario 2, SC-002). The same browser
  // context keeps the virtual authenticator's resident credential from the
  // registration.
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "carol");

  await signOut(page, "carol");
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
    // The primary username-less action and the "First time?" hint are
    // visible; the Username field stays hidden until the hint is clicked
    // (US1, FR-011). The ceremony is not triggered here: this context has
    // no credential and the empty sheet is asserted via the hint's
    // presence on the page.
    await expect(
      page.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "First time? Use your username" }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toBeHidden();
    await page
      .getByRole("link", { name: "First time? Use your username" })
      .click();
    await expect(page.getByLabel("Username")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create passkey" }),
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
