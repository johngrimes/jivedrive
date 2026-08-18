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

  // First sign-in: the seeded user has no passkey, so one is created and
  // the user lands on the files page signed in.
  await page.goto("/");
  await signIn(page, "alice");
  await expect(page).toHaveURL(/\/files/);
  await expectSignedInAs(page, "alice");

  // Sign out returns to the sign-in form.
  await signOut(page, "alice");
  await expect(page.getByLabel("Username")).toBeVisible();

  // Second sign-in uses the registered passkey (assertion ceremony).
  await signIn(page, "alice");
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

  // Sign out, then sign in again with the newly registered passkey.
  await signOut(page, "carol");
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
