import { expect, test } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Start signed in with the pre-seeded session (no WebAuthn ceremony) and
 * open the photos subfolder, where the delete tests live. Each test targets
 * its own dedicated object (see e2eServer.ts), so the tests and the other
 * specs never race each other on shared objects.
 *
 * @param page - the page
 * @param context - the browser context
 */
async function openPhotos(page: Page, context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");
  // photos/ sorts onto the second page of the seeded root listing
  // (11 items, page size 5), so load the rest before navigating; one
  // Load more click still brings it into view.
  await page.getByRole("button", { name: "Load more" }).click();
  await page.getByRole("link", { name: /photos/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("photos");
}

/**
 * Open the delete confirmation dialog for the file row containing the
 * given text and wait for the dialog to show it.
 *
 * @param page - the page
 * @param rowText - text identifying the file row
 * @returns the delete dialog locator
 */
async function openDelete(page: Page, rowText: string) {
  await page
    .locator("li.list-row", { hasText: rowText })
    .getByRole("button", { name: "Delete" })
    .click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(rowText);
  return dialog;
}

test("cancelling the delete dialog leaves the file untouched", async ({
  page,
  context,
}) => {
  await openPhotos(page, context);
  const row = page.locator("li.list-row", { hasText: "delete-me-cancel.txt" });
  await expect(row).toBeVisible();

  // The dialog names the file and warns that deletion is permanent.
  const dialog = await openDelete(page, "delete-me-cancel.txt");
  await expect(dialog).toContainText(/cannot be undone|permanently/);

  // Cancel closes the dialog without any request: the row remains.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();

  // The dialog and listing stay usable on a narrow viewport.
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(row).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("confirming the delete removes the file from the listing", async ({
  page,
  context,
}) => {
  await openPhotos(page, context);
  const row = page.locator("li.list-row", { hasText: "delete-me-confirm.txt" });
  await expect(row).toBeVisible();

  const dialog = await openDelete(page, "delete-me-confirm.txt");

  // While the delete is in flight the buttons are disabled and a pending
  // state is shown (visibility of system status).
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(
    dialog.getByRole("button", { name: "Deleting..." }),
  ).toBeDisabled();

  // On success the dialog closes and the file disappears from the listing.
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator("li.list-row", { hasText: "delete-me-confirm.txt" }),
  ).toHaveCount(0);
});

test("a failed delete shows a clear error and leaves the listing unchanged", async ({
  page,
  context,
}) => {
  await openPhotos(page, context);
  const row = page.locator("li.list-row", { hasText: "delete-me-missing.txt" });
  await expect(row).toBeVisible();

  // Simulate the object vanishing between listing and delete: the server
  // answers the delete with 404 (missing object). Listing requests pass
  // through untouched.
  await page.route(/\/api\/files\?key=/, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: "The file does not exist",
          code: "not_found",
        }),
      });
    }
    return route.continue();
  });

  const dialog = await openDelete(page, "delete-me-missing.txt");
  await dialog.getByRole("button", { name: "Delete" }).click();

  // A clear error is shown, the dialog stays open and the row remains.
  await expect(dialog.getByRole("alert")).toContainText(
    "The file does not exist",
  );
  await expect(row).toBeVisible();

  // Cancel still closes the dialog after a failed delete.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});
