import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

/**
 * File search (007-file-search US1). The e2e server seeds alice's space
 * and runs the search-index scan every 2 seconds, so seeded objects are
 * searchable shortly after server start: every assertion on results
 * polls with a generous timeout instead of assuming the first scan has
 * finished (R-010).
 */

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
