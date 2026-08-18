import { expect, test } from "@playwright/test";
import {
  enableVirtualAuthenticator,
  enrollViaInvite,
  expectSignedInAs,
  signOut,
} from "./helpers";

test("a seeded user enrolls via an invite link, signs in with a passkey and signs out", async ({
  page,
  context,
}, testInfo) => {
  await enableVirtualAuthenticator(context, page);

  // US4: every response carries the hardened header set. The real page
  // load response is asserted here (CSP, frame/clickjacking, MIME-sniffing,
  // referrer and permission headers); the ceremony below then proves the
  // SPA still works under the CSP.
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["referrer-policy"]).toBe("same-origin");
  expect(response?.headers()["permissions-policy"]).toBe(
    "camera=(), microphone=(), geolocation=()",
  );

  // First enrollment: the seeded user has no passkey, so the first
  // (discoverable) passkey attaches to the existing account via a seeded
  // invite (US1 attach semantics) and the user lands on the files page
  // signed in. The -rN suffix keeps CI retries working: the e2e server
  // keeps one in-memory database for the whole run, so a failed attempt
  // that already claimed invite-alice would leave the retry without a
  // fresh pending invite.
  const token =
    testInfo.retry > 0 ? `invite-alice-r${testInfo.retry}` : "invite-alice";
  await enrollViaInvite(page, token);
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
    // The token-gated sign-in page (US1, FR-001/FR-002) offers exactly two
    // paths: the primary username-less passkey button and the invite-link
    // registration path. There is no username input and no "First time?"
    // fallback form anymore. The ceremony is not triggered here: this
    // context has no credential.
    await expect(
      page.getByRole("button", { name: "Sign in with passkey" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Register with an invite link" }),
    ).toBeVisible();
    await expect(page.getByLabel("Username")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "First time? Use your username" }),
    ).toHaveCount(0);
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
