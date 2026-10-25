import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Start signed in via a pre-seeded session (seeded in e2eServer.ts) and
 * open Settings through the header gear.
 *
 * @param page - the page
 * @param context - the browser context
 * @param token - the session token
 * @param username - the session's username
 */
async function openSettingsViaGear(
  page: Page,
  context: BrowserContext,
  token: string,
  username: string,
): Promise<void> {
  await context.addCookies([
    { name: "jivedrive_session", value: token, url: "http://localhost:5173" },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, username);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sync with rclone" }),
  ).toBeVisible();
}

/**
 * A key label unique to this test attempt (retry-safe).
 *
 * @param base - the label stem
 * @param testInfo - the running test's info
 * @returns the label
 */
function keyLabel(base: string, testInfo: TestInfo): string {
  return `${base}-r${testInfo.retry}-${Date.now().toString(36)}`;
}

test("a member creates an rclone key, sees its config once, and revokes it", async ({
  page,
  context,
}, testInfo) => {
  await openSettingsViaGear(page, context, "sync-session", "sami");

  // Non-admins have no Manage users link.
  await expect(page.getByRole("link", { name: "Manage users" })).toHaveCount(0);

  const label = keyLabel("laptop", testInfo);
  await page.getByLabel("Key label").fill(label);
  await page.getByRole("button", { name: "Create key" }).click();

  const panel = page.getByRole("region", { name: "New sync key" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("won't be shown again");
  await expect(panel).toContainText("up to about a minute");

  // The raw values carry the access key and the secret; the config
  // embeds both and defines the alias remote onto the user's prefix.
  const accessKeyId = (
    await panel.getByRole("definition").nth(0).textContent()
  )?.trim();
  expect(accessKeyId).toBeTruthy();
  const secret = (
    await panel.getByRole("definition").nth(1).textContent()
  )?.trim();
  expect(secret).toBeTruthy();
  const config = await panel
    .getByLabel("rclone config", { exact: true })
    .textContent();
  expect(config).toContain("[jivedrive-s3]");
  expect(config).toContain(`access_key_id = ${accessKeyId}`);
  expect(config).toContain(`secret_access_key = ${secret}`);
  expect(config).toContain("[jivedrive]");
  expect(config).toContain("type = alias");
  expect(config).toContain("remote = jivedrive-s3:jivedrive-prod/users/sami/");
  await expect(panel).toContainText("rclone sync jivedrive: ~/JiveDrive");
  await expect(panel).toContainText(
    "mkdir -p ~/JiveDrive && rclone bisync jivedrive: ~/JiveDrive --resync",
  );

  // Copy gives explicit feedback.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "Copy rclone config" }).click();
  await expect(panel.getByText("Copied to clipboard")).toBeVisible();

  // Dismissing removes the secret from the page for good.
  await panel.getByRole("button", { name: "I've saved it" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(secret!)).toHaveCount(0);

  const row = page
    .getByRole("table", { name: "Sync keys" })
    .locator("tbody tr", { hasText: label });
  await expect(row).toBeVisible();
  await expect(row).toContainText(accessKeyId!);
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.getByText(secret!)).toHaveCount(0);

  // Revoke asks for confirmation, then reports success.
  await row.getByRole("button", { name: `Revoke key ${label}` }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(label);
  await expect(dialog).toContainText("stops working within a few minutes");
  await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      `Revoked key "${label}". It will stop working within a few minutes.`,
    ),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("a storage provider failure while creating a key is shown as an error", async ({
  page,
  context,
}, testInfo) => {
  // The fake OVH API refuses to create the OVH user for "syncfail".
  await openSettingsViaGear(page, context, "syncfail-session", "syncfail");

  await page.getByLabel("Key label").fill(keyLabel("doomed", testInfo));
  await page.getByRole("button", { name: "Create key" }).click();

  await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "New sync key" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("table", { name: "Sync keys" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create key" })).toBeEnabled();
});

test("an admin reaches user management from Settings", async ({
  page,
  context,
}) => {
  await openSettingsViaGear(page, context, "admin-session", "admin");

  await page.getByRole("link", { name: "Manage users" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();
});
