import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Start signed in with the pre-seeded session (no WebAuthn ceremony; the
 * sign-in flows are covered by auth.spec) and open the space root.
 *
 * @param page - the page
 * @param context - the browser context
 */
async function startSignedIn(
  page: Page,
  context: BrowserContext,
): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");
}

/**
 * Open the share modal for the file row containing the given text and wait
 * for the generated link to appear.
 *
 * @param page - the page
 * @param rowText - text identifying the file row
 * @returns the share dialog locator
 */
async function openShare(page: Page, rowText: string) {
  await page
    .locator("tr", { hasText: rowText })
    .getByRole("button", { name: "Share" })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(rowText);
  await expect(dialog.getByLabel("Share link")).toHaveValue(/X-Amz-Signature/);
  return dialog;
}

test("generates a share link with the default expiry, copies it, and reflects expiry changes", async ({
  page,
  context,
}) => {
  await startSignedIn(page, context);
  // readme.md sorts onto the second page of the seeded listing.
  await page.getByRole("button", { name: "Load more" }).click();
  const dialog = await openShare(page, "readme.md");

  // Default expiry is 7 days: the presigned URL carries X-Amz-Expires
  // = 604800 and points at the storage provider, not the app.
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=604800/,
  );
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /localhost:5299\/jivedrive-prod\/users\/alice\/readme\.md/,
  );
  // Fire-and-forget note per the wireframe.
  await expect(dialog.getByText(/Not stored by JiveDrive/)).toBeVisible();

  // Selecting a different expiry regenerates the link (US4 scenario 2).
  await dialog.getByLabel("Link expires in").selectOption({ label: "1 hour" });
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=3600/,
  );

  await dialog
    .getByLabel("Link expires in")
    .selectOption({ label: "24 hours" });
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=86400/,
  );

  await dialog
    .getByLabel("Link expires in")
    .selectOption({ label: "30 days (7-day maximum)" });
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=604800/,
  );
  // The dialog states the real expiry rather than the nominal 30 days
  // (the SigV4 presigned-TTL cap is 7 days).
  await expect(dialog.getByText(/Link expires \d/)).toBeVisible();

  await dialog
    .getByLabel("Link expires in")
    .selectOption({ label: "7 days (default)" });
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=604800/,
  );

  // Copy: the clipboard receives exactly the generated link.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:5173",
  });
  const link = await dialog.getByLabel("Share link").inputValue();
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(link);

  // Done closes the modal.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // The modal is fully usable on a narrow viewport (constitution VI).
  await openShare(page, "readme.md");
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("the share URL response carries the chosen expiry and a matching expiresAt", async ({
  page,
  context,
}) => {
  await startSignedIn(page, context);
  const dialog = await openShare(page, "data.csv");

  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/files/share-url") &&
      res.request().postDataJSON()?.expiresIn === "1h",
  );
  await dialog.getByLabel("Link expires in").selectOption({ label: "1 hour" });
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { url: string; expiresAt: string };
  expect(body.url).toContain("X-Amz-Expires=3600");
  const expiresAt = new Date(body.expiresAt).getTime();
  expect(Math.abs(expiresAt - (Date.now() + 3600 * 1000))).toBeLessThan(10_000);
  await expect(dialog.getByLabel("Share link")).toHaveValue(
    /X-Amz-Expires=3600/,
  );
});

test("the generated link downloads the file in a fresh context without a session", async ({
  page,
  context,
  browser,
}: {
  page: Page;
  context: BrowserContext;
  browser: Browser;
}) => {
  await startSignedIn(page, context);
  const dialog = await openShare(page, "data.csv");
  const link = await dialog.getByLabel("Share link").inputValue();
  expect(link).toContain("localhost:5299");
  expect(link).toContain("X-Amz-Signature");

  // A brand-new context carries no cookies: opening the presigned URL
  // still downloads the file, mirroring S3's public presigned behaviour
  // (FR-011, US4 scenario 3). The mock download server has no auth.
  const anon = await browser.newContext();
  try {
    const res = await anon.request.get(link);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe("a,b,c\n1,2,3");
  } finally {
    await anon.close();
  }
});
