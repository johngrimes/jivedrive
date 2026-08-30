import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * File search (007-file-search US1). The e2e server seeds alice's space
 * and runs the search-index scan every 2 seconds, so seeded objects are
 * searchable shortly after server start: every assertion on results
 * polls with a generous timeout instead of assuming the first scan has
 * finished (R-010).
 */

const fixturesDir = fileURLToPath(
  new URL("../backend/tests/fixtures", import.meta.url),
);
/** The indexed results take up to one scan interval to appear. */
const INDEX_TIMEOUT = 20_000;

/**
 * Submit a filename search from the Files page search box.
 *
 * @param page - the signed-in Files page
 * @param query - the query to type and submit
 */
async function search(page: import("@playwright/test").Page, query: string) {
  const box = page.getByRole("searchbox", { name: "Search files" });
  await box.fill(query);
  await box.press("Enter");
}

test.beforeEach(async ({ page, context }) => {
  // Start signed in with the pre-seeded session (the sign-in ceremony is
  // covered by auth.spec). Domain/path form keeps the spec independent
  // of the port the server runs on.
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      domain: "localhost",
      path: "/",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "alice");
});

test("filename search finds files across the whole space with their paths", async ({
  page,
}) => {
  await search(page, "report");

  // Root file and nested file, wherever they sit in the space (US1 sc.1).
  await expect(page.getByText("report.pdf").first()).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  await expect(page.getByText("report.pdf")).toHaveCount(2);

  // Each result shows its containing folder as a breadcrumb path: the
  // root file under Home, the nested one under projects / docs (FR-003).
  await expect(
    page.locator("li.list-row", { hasText: "projects / docs" }),
  ).toBeVisible();

  // Match-type badges are shown on every row.
  await expect(page.getByText("Name match")).toHaveCount(2);
});

test("clicking a result navigates to the containing folder and restores the listing", async ({
  page,
}) => {
  await search(page, "plan");

  const result = page.locator("li.list-row", { hasText: "plan.txt" });
  await expect(result).toBeVisible({ timeout: INDEX_TIMEOUT });

  await result.getByRole("link", { name: /plan\.txt/ }).click();

  // The listing for projects/ replaced the results (US1 sc.4).
  await expect(page.getByText("Name match")).toHaveCount(0);
  await expect(page.getByText("2 items")).toBeVisible();
  await expect(page.getByText("plan.txt")).toBeVisible();
});

test("a query with no matches shows a clear empty state", async ({ page }) => {
  await search(page, "zzz-no-such-file-xyz");

  await expect(page.getByText(/No files match/)).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  // No result rows render for the empty state (US1 sc.5).
  await expect(page.locator("li.list-row")).toHaveCount(0);
});

test("the search UI is fully usable at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(
    page.getByRole("searchbox", { name: "Search files" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await search(page, "report");

  // Results render single-column with no overflow at 375px (FR-015).
  await expect(page.getByText("report.pdf").first()).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  await expectNoHorizontalOverflow(page);

  // Clearing restores the folder listing (US1 sc.6).
  await page.getByRole("button", { name: "Clear" }).first().click();
  await expect(page.getByText("archive.zip")).toBeVisible();
  await expect(page.getByText("Name match")).toHaveCount(0);
});

test("content search finds uploaded txt/pdf/docx by phrase with snippets, below name matches", async ({
  page,
  context,
}) => {
  // A per-attempt folder and names keep CI retries independent: the e2e
  // server keeps one in-memory database for the whole run, so a retried
  // attempt must not collide with an already-uploaded file.
  const attempt = `${Date.now()}`;
  await page.goto(`/files?prefix=content-search-${attempt}/`);
  await expectSignedInAs(page, "alice");

  const uploads = [
    {
      // A name match: the phrase is in the name, not the body.
      name: `zephyrquill notes ${attempt}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from("unrelated body words"),
    },
    {
      // Content matches: the phrase is inside the document text
      // ("quarterly budget review zephyrquill", per the fixtures).
      name: `needle-${attempt}.pdf`,
      mimeType: "application/pdf",
      buffer: readFileSync(join(fixturesDir, "sample.pdf")),
    },
    {
      name: `needle-${attempt}.docx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: readFileSync(join(fixturesDir, "sample.docx")),
    },
  ];
  for (const file of uploads) {
    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByText(`Uploaded ${file.name}`)).toBeVisible();
  }

  // Search from the space root: results span the whole space (US1 sc.3).
  await page.goto("/files");
  await search(page, "zephyrquill");

  // The name match ranks first (R-008); the two content matches follow,
  // once the scan has indexed the uploads (R-010). Rows are scoped to
  // this attempt's unique names: the shared in-memory server keeps every
  // earlier attempt's (equally searchable) uploads around.
  const rows = page
    .locator("li.list-row")
    .filter({ hasText: attempt });
  await expect(rows).toHaveCount(3, { timeout: INDEX_TIMEOUT });
  const nameRow = rows.filter({ hasText: "Name match" });
  await expect(nameRow).toHaveCount(1);
  await expect(nameRow.locator("mark")).toHaveCount(0);

  const contentRows = rows.filter({ hasText: "Content match" });
  await expect(contentRows).toHaveCount(2);
  // Each content match shows the document text around the phrase, with
  // the phrase highlighted in a <mark> (FR-005).
  for (const row of await contentRows.all()) {
    await expect(row.locator("mark").first()).toHaveText("zephyrquill");
    await expect(row).toContainText("quarterly budget review");
  }
  await expectNoHorizontalOverflow(page);
});
