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
  await signIn(context);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");
  await page.getByRole("link", { name: /docs/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("docs");
}

/**
 * Add alice's pre-seeded session cookie to the context (no WebAuthn
 * ceremony).
 *
 * @param context - the browser context
 */
async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
}

/**
 * Start signed in and open a brand-new folder under docs/reports, unique
 * to this attempt. Batch tests upload several files, which would push the
 * docs/ listing past the 5-item e2e page size and break retries; a fresh
 * folder per attempt keeps them isolated. reports/ carries no count
 * assertions, and its seeded "2026" folder sorts ahead of these.
 *
 * @param page - the page
 * @param context - the browser context
 * @param label - a readable stem for the folder name
 * @returns the folder's prefix relative to the space root
 */
async function openFreshFolder(
  page: Page,
  context: BrowserContext,
  label: string,
): Promise<string> {
  await signIn(context);
  const prefix = `docs/reports/${label}-${Date.now()}/`;
  await page.goto(`/files?prefix=${encodeURIComponent(prefix)}`);
  await expectSignedInAs(page, "alice");
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText(label);
  return prefix;
}

/**
 * Attach several files to the upload input in one pick.
 *
 * @param page - the page
 * @param files - name and content of each file, in pick order
 */
async function chooseFiles(
  page: Page,
  files: Array<{ name: string; content: string }>,
): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(
    files.map(({ name, content }) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(content),
    })),
  );
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

  // Explicit success feedback, then the file appears with its name shown
  // verbatim (spaces and special characters preserved).
  await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();
  const row = page.locator("li.list-row", { hasText: fileName });
  await expect(row).toBeVisible();

  // The upload control stays usable on a narrow viewport.
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(row).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("uploading over an existing name asks for confirmation before replacing", async ({
  page,
  context,
}) => {
  await openDocs(page, context);

  const fileName = "report.pdf";
  await chooseFile(page, fileName, "v1");
  const row = page.locator("li.list-row", { hasText: fileName });
  await expect(row).toBeVisible();

  // A second upload of the same name is refused until the user confirms.
  await chooseFile(page, fileName, "a longer replacement version");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("report.pdf");
  await expect(dialog).toContainText("already exists");

  // Skip leaves the stored object untouched: the row stays.
  await dialog.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Skipped ${fileName}`)).toBeVisible();
  await expect(row).toBeVisible();

  // Confirming replaces the object: the dialog closes.
  await chooseFile(page, fileName, "a longer replacement version");
  await expect(dialog).toContainText("already exists");
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("a failed upload shows a clear error and leaves the listing unchanged", async ({
  page,
  context,
}) => {
  await openDocs(page, context);

  // The mock S3 layer rejects this file name with a 500.
  await chooseFile(page, "broken.txt", "rejected by the mock");

  await expect(page.getByText(/Could not upload "broken\.txt"/)).toBeVisible();
  await expect(
    page.locator("li.list-row", { hasText: "broken.txt" }),
  ).toHaveCount(0);
});

test("uploads several selected files in one go, counting through the batch", async ({
  page,
  context,
}) => {
  await openFreshFolder(page, context, "batch");

  const names = ["batch one.txt", "batch #2?.txt", "batch three.txt"];
  await chooseFiles(
    page,
    names.map((name) => ({ name, content: `content of ${name}` })),
  );

  // Visibility of system status: the file in flight has a progress bar
  // and the label counts through the batch, in pick order.
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(
    page.getByText("Uploading batch one.txt (1 of 3)"),
  ).toBeVisible();
  await expect(
    page.getByText("Uploading batch three.txt (3 of 3)"),
  ).toBeVisible();

  await expect(
    page.getByText("Uploaded 3 files", { exact: true }),
  ).toBeVisible();
  for (const name of names) {
    await expect(page.locator("li.list-row", { hasText: name })).toBeVisible();
  }

  // The control and its summary stay usable on a narrow viewport.
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(
    page.getByText("Uploaded 3 files", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("a batch with conflicts and a failure: skip one, replace the rest, and summarise", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const prefix = await openFreshFolder(page, context, "conflicts");

  await chooseFiles(page, [
    { name: "a.txt", content: "v1" },
    { name: "b.txt", content: "v1" },
    { name: "c.txt", content: "v1" },
  ]);
  await expect(
    page.getByText("Uploaded 3 files", { exact: true }),
  ).toBeVisible();

  const v2 = "a longer second version";
  await chooseFiles(page, [
    { name: "a.txt", content: v2 },
    { name: "b.txt", content: v2 },
    { name: "c.txt", content: v2 },
    { name: "d.txt", content: v2 },
    // The mock S3 layer rejects this name with a 500.
    { name: "broken.txt", content: v2 },
  ]);

  // The first conflict asks about a.txt alone: Skip keeps it.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText('A file named "a.txt" already exists');
  const applyToRemaining = dialog.getByRole("checkbox", {
    name: "Apply to remaining conflicts",
  });
  await expect(applyToRemaining).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Skip" }).click();

  // The next conflict asks again; replacing with "apply to remaining"
  // covers c.txt too, so no further dialog appears.
  await expect(dialog).toContainText('A file named "b.txt" already exists');
  await applyToRemaining.check();
  await dialog.getByRole("button", { name: "Replace" }).click();

  // The failure does not stop the batch: d.txt still uploads, and the
  // summary reports the counts and names the failed file.
  const summary = page.getByRole("alert");
  await expect(summary).toContainText("Uploaded 3 of 5 files, skipped 1");
  await expect(summary).toContainText('Could not upload "broken.txt"');
  await expect(dialog).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page.locator("li.list-row", { hasText: "d.txt" })).toBeVisible();
  await expect(
    page.locator("li.list-row", { hasText: "broken.txt" }),
  ).toHaveCount(0);

  // Storage holds exactly what the answers asked for: a.txt kept, b.txt
  // and c.txt replaced.
  const response = await page.request.get(
    `/api/files?prefix=${encodeURIComponent(prefix)}`,
  );
  expect(response.status()).toBe(200);
  const listing = (await response.json()) as {
    files: Array<{ name: string; size: number }>;
  };
  const sizes = Object.fromEntries(
    listing.files.map((file) => [file.name, file.size]),
  );
  expect(sizes).toEqual({
    "a.txt": 2,
    "b.txt": v2.length,
    "c.txt": v2.length,
    "d.txt": v2.length,
  });
});
