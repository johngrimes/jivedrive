import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  chooseRowAction,
  downloadFromPopup,
  expectNoHorizontalOverflow,
  expectSignedInAs,
  readStream,
} from "./helpers";

/**
 * Read the body of a download triggered from the given file row, either
 * by its menu's Download item or by clicking the file name: the app opens
 * the presigned URL in a new window, so the download is captured from
 * that popup.
 *
 * @param page - the page
 * @param rowText - the file name identifying the row
 * @param via - "menu" for the ⋯ Download item, "name" for the name link
 * @returns the download and its content
 */
async function downloadFromRow(
  page: Page,
  rowText: string,
  via: "menu" | "name",
) {
  const row = page.locator("li.list-row", { hasText: rowText });
  const download = await downloadFromPopup(page, () =>
    via === "menu"
      ? chooseRowAction(row, "Download")
      : row.getByRole("link", { name: rowText, exact: true }).click(),
  );
  const content = await readStream(await download.createReadStream());
  return { download, content };
}

test("a signed-in user browses folders, loads more pages and downloads files", async ({
  page,
  context,
}) => {
  // Start signed in with the pre-seeded session (the sign-in ceremony is
  // covered by auth.spec; alice's passkey registration must not race this
  // spec's requests).
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");

  // Root listing: folders and files, and the loaded item count. Folder
  // rows are links (they navigate); file rows carry button
  // Download/Share/Delete actions.
  await expect(page.getByRole("link", { name: /docs/ })).toBeVisible();
  await expect(page.getByText("archive.zip")).toBeVisible();
  await expect(page.getByText("5 items")).toBeVisible();

  // The listing is usable at mobile, tablet and desktop widths.
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByText("archive.zip")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  // Load more: the first page has 5 rows and a Load more button; the
  // second page brings the total to 10 and the button remains; the third
  // page completes the 11-entry root and the button disappears.
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await expect(page.locator("li.list-row")).toHaveCount(5);
  await loadMore.click();
  await expect(page.locator("li.list-row")).toHaveCount(10);
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await expect(page.locator("li.list-row")).toHaveCount(11);
  await expect(loadMore).toHaveCount(0);
  await expect(page.getByText("11 items")).toBeVisible();
  await expect(page.getByRole("link", { name: /photos/ })).toBeVisible();

  // Navigate into a folder: the listing updates and breadcrumbs show the
  // current folder.
  await page.getByRole("link", { name: /docs/ }).click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("docs");
  await expect(page.getByText("notes.txt")).toBeVisible();
  await expect(page.getByText("my file #1?.txt")).toBeVisible();

  // Download a file from its row menu: the browser fetches the presigned
  // URL from the mock S3 and receives the file bytes.
  const notes = await downloadFromRow(page, "notes.txt", "menu");
  expect(notes.download.suggestedFilename()).toBe("notes.txt");
  expect(notes.download.url()).toContain("localhost:5299");
  expect(notes.download.url()).toContain("X-Amz-Signature");
  expect(notes.content.toString()).toBe("hello from notes");

  // Clicking a file's name downloads it too. File names with spaces and
  // special characters keep their encoding in the presigned download URL.
  const special = await downloadFromRow(page, "my file #1?.txt", "name");
  expect(special.download.url()).toContain("my%20file%20%231%3F.txt");
  expect(special.content.toString()).toBe("special file content");

  // The breadcrumb for the space root navigates back up.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("archive.zip")).toBeVisible();
  await expect(page.getByText("5 items")).toBeVisible();

  // An empty subfolder shows a friendly empty state, not an error.
  await page.getByRole("link", { name: /empty/ }).click();
  await expect(page.getByText(/This folder is empty/)).toBeVisible();
  await expect(page.locator("li.list-row")).toHaveCount(0);
});
