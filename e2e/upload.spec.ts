import { expect, test } from "@playwright/test";
import type { Page, BrowserContext } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * Start signed in with the pre-seeded session (no WebAuthn ceremony) and
 * open the docs subfolder, where these tests upload. Keeping uploads out
 * of the space root leaves the root item counts asserted by browse.spec
 * stable, since all e2e tests share one server and object store.
 *
 * @param page - the page
 * @param context - the browser context
 */
async function openDocs(page: Page, context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");
  await page.getByRole("button", { name: /docs/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("docs");
}

/**
 * Attach a file with the given name and content to the upload input.
 *
 * @param page - the page
 * @param fileName - the browser-side file name, used verbatim
 * @param content - the file content
 */
async function chooseFile(
  page: Page,
  fileName: string,
  content: string,
): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(content),
  });
}

test("uploads a new file with progress feedback and shows it in the listing", async ({
  page,
  context,
}) => {
  await openDocs(page, context);

  const fileName = "quarterly report #1?.txt";
  await chooseFile(page, fileName, "quarterly numbers\n");

  // Visibility of system status: an uploading indicator with progress.
  await expect(page.getByRole("progressbar")).toBeVisible();

  // Explicit success feedback, then the file appears with its size and the
  // name shown verbatim (spaces and special characters preserved).
  await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: fileName })).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: fileName })).toContainText(
    "18 B",
  );

  // The upload control stays usable on a narrow viewport.
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.locator("tbody tr", { hasText: fileName })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("uploading over an existing name asks for confirmation before replacing", async ({
  page,
  context,
}) => {
  await openDocs(page, context);

  const fileName = "report.pdf";
  await chooseFile(page, fileName, "v1");
  await expect(page.locator("tbody tr", { hasText: fileName })).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: fileName })).toContainText(
    "2 B",
  );

  // A second upload of the same name is refused until the user confirms.
  await chooseFile(page, fileName, "a longer replacement version");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("report.pdf");
  await expect(dialog).toContainText("already exists");

  // Cancel leaves the stored object untouched: the size is unchanged.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("tbody tr", { hasText: fileName })).toContainText(
    "2 B",
  );

  // Confirming replaces the object: the listing shows the new size.
  await chooseFile(page, fileName, "a longer replacement version");
  await expect(dialog).toContainText("already exists");
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("tbody tr", { hasText: fileName })).toContainText(
    "28 B",
  );
});

test("a failed upload shows a clear error and leaves the listing unchanged", async ({
  page,
  context,
}) => {
  await openDocs(page, context);

  // The mock S3 layer rejects this file name with a 500.
  await chooseFile(page, "broken.txt", "rejected by the mock");

  await expect(page.getByText(/Could not upload "broken\.txt"/)).toBeVisible();
  await expect(page.locator("tbody tr", { hasText: "broken.txt" })).toHaveCount(
    0,
  );
});
