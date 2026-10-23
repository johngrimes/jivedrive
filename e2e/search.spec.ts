import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import {
  downloadFromPopup,
  expectNoHorizontalOverflow,
  expectSignedInAs,
  readStream,
} from "./helpers";

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
async function search(page: Page, query: string) {
  const box = page.getByRole("searchbox", { name: "Search files and folders" });
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

  await expect(page.getByText(/No files or folders match/)).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  // No result rows render for the empty state (US1 sc.5).
  await expect(page.locator("li.list-row")).toHaveCount(0);
});

test("the search UI is fully usable at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(
    page.getByRole("searchbox", { name: "Search files and folders" }),
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

test("the search UI is fully usable at tablet width", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(
    page.getByRole("searchbox", { name: "Search files and folders" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await search(page, "report");

  await expect(page.getByText("report.pdf").first()).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Clear" }).first().click();
  await expect(page.getByText("archive.zip")).toBeVisible();
  await expect(page.getByText("Name match")).toHaveCount(0);
});

test("content search finds uploaded txt/pdf/docx by phrase with snippets, below name matches", async ({
  page,
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

  // The name match ranks first (R-008); the two content matches follow
  // once the scan has indexed the uploads (R-010). The results list
  // fetches once per submitted query and never auto-refreshes, while the
  // scan indexer runs on its 2 s interval: a query submitted before the
  // next scan picks up the last upload shows a partial snapshot that
  // would never update. Re-submit the query — from a cleared state, so a
  // re-submission of the same string refetches — until the scan has
  // indexed all three uploads. Rows are scoped to this attempt's unique
  // names: the shared in-memory server keeps every earlier attempt's
  // (equally searchable) uploads around.
  await expect(async () => {
    const clear = page.getByRole("button", { name: "Clear" });
    if (await clear.isVisible()) await clear.click();
    await search(page, "zephyrquill");
    await expect(
      page
        .locator("li.list-row")
        .filter({ hasText: attempt })
        .filter({ hasText: "Content match" }),
    ).toHaveCount(2);
  }).toPass({ timeout: INDEX_TIMEOUT });

  const rows = page.locator("li.list-row").filter({ hasText: attempt });
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
/**
 * The outgoing share shape returned by GET /api/shares (contract
 * `ShareOutgoing`), as used by the US3 specs below.
 */
interface ShareOutgoingBody {
  id: string;
  folderName: string;
  recipient: { username: string };
}

/** The response of GET /api/shares. */
interface ListSharesBody {
  incoming: unknown[];
  outgoing: ShareOutgoingBody[];
}

/**
 * Sign in as the given pre-seeded user by replacing the session cookie
 * the beforeEach installed, then open the Files page.
 *
 * @param page - the page
 * @param context - the browser context
 * @param username - expected header username
 * @param token - the user's pre-seeded session token
 */
async function startSignedInAs(
  page: Page,
  context: BrowserContext,
  username: string,
  token: string,
) {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: token,
      domain: "localhost",
      path: "/",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, username);
}

test.describe.configure({ mode: "serial" });

test("US3: a recipient's search shows the shared label and downloads from the shared space", async ({
  page,
  context,
}) => {
  // alice shares her docs folder with bob via the API (the mount list is
  // covered by share-folder.spec; search resolves the share live).
  await startSignedInAs(page, context, "alice", "browse-session");
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "docs/", recipientUsername: "flo" },
  });
  expect([201, 409]).toContain(shareRes.status());

  await startSignedInAs(page, context, "flo", "flo-session");
  await search(page, "notes");

  // The sharer's indexed file appears labelled "Shared by alice" (US3
  // sc.1) with its mount-relative path.
  const row = page.locator("li.list-row", { hasText: "notes.txt" });
  await expect(row).toBeVisible({ timeout: INDEX_TIMEOUT });
  await expect(row).toContainText("Shared by alice");

  // Download from the result is issued against the shared space and
  // succeeds (US3 sc.3): the presigned URL opens in a new window.
  const download = await downloadFromPopup(page, () =>
    row.getByRole("button", { name: "Download" }).click(),
  );
  const content = await readStream(await download.createReadStream());
  expect(content.toString()).toBe("hello from notes");
});

test("US3: revoking the share removes its search results immediately", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "alice", "browse-session");
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "photos/", recipientUsername: "flo" },
  });
  expect([201, 409]).toContain(shareRes.status());
  const sharesBody = (await (
    await page.request.get("/api/shares")
  ).json()) as ListSharesBody;
  const share = sharesBody.outgoing.find(
    (entry) =>
      entry.folderName === "photos" && entry.recipient.username === "flo",
  );
  expect(share).toBeDefined();

  await startSignedInAs(page, context, "flo", "flo-session");
  await search(page, "pic");
  const row = page.locator("li.list-row", { hasText: "pic.jpg" });
  await expect(row).toBeVisible({ timeout: INDEX_TIMEOUT });
  await expect(row).toContainText("Shared by alice");

  // alice revokes: the next search drops the mount's results at query
  // time — no scan runs in between (FR-011, US3 sc.4).
  await startSignedInAs(page, context, "alice", "browse-session");
  const revokeRes = await page.request.delete(`/api/shares/${share?.id}`);
  expect(revokeRes.status()).toBe(204);

  await startSignedInAs(page, context, "flo", "flo-session");
  await search(page, "pic");
  await expect(page.getByText(/No files or folders match/)).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  await expect(page.locator("li.list-row")).toHaveCount(0);
});

test("US3: a non-recipient's search never returns the sharer's files", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "alice", "browse-session");
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "docs/", recipientUsername: "flo" },
  });
  expect([201, 409]).toContain(shareRes.status());

  // gina holds no share from alice: nothing from alice's space may
  // surface, even though it is indexed (FR-012, US3 sc.5).
  await startSignedInAs(page, context, "gina", "gina-session");
  await search(page, "notes");

  await expect(page.getByText(/No files or folders match/)).toBeVisible({
    timeout: INDEX_TIMEOUT,
  });
  await expect(page.locator("li.list-row")).toHaveCount(0);
});

test("US4: an admin reindex makes an upload searchable and a deletion disappear", async ({
  page,
  context,
}) => {
  const attempt = `${Date.now()}`;
  const fileName = `reindex-${attempt}.txt`;

  // alice uploads a document containing a unique phrase.
  await page.goto(`/files?prefix=reindex-${attempt}/`);
  await expectSignedInAs(page, "alice");
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(`the xenocryptic ${attempt} phrase`),
  });
  await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();

  // The admin forces an immediate reindex of alice's space; the request
  // is accepted (202) and the scan runs in the background (FR-017,
  // US4 sc.7).
  await startSignedInAs(page, context, "admin", "admin-session");
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();
  const aliceRow = page
    .getByRole("table", { name: "Users" })
    .locator("tbody tr", {
      has: page.getByRole("cell").getByText("alice", { exact: true }),
    });
  await aliceRow.getByRole("button", { name: "Rebuild search index" }).click();
  await expect(page.locator("p.alert-success")).toContainText(
    `Search index rebuild started for "alice".`,
  );

  // The reindexed content is searchable. The scan runs in the
  // background and the results page fetches once per submitted query,
  // so poll by re-navigating and searching until it surfaces.
  await startSignedInAs(page, context, "alice", "browse-session");
  await expect(async () => {
    await page.goto("/files");
    await search(page, "xenocryptic");
    const row = page.locator("li.list-row", { hasText: fileName });
    await expect(row).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: INDEX_TIMEOUT });
  const row = page.locator("li.list-row", { hasText: fileName });
  await expect(row.locator("mark").first()).toHaveText("xenocryptic");

  // alice deletes the file; a second admin reindex drops it from the
  // index without waiting for the next scheduled scan (US4 sc.3).
  await row.getByRole("button", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await startSignedInAs(page, context, "admin", "admin-session");
  await page.goto("/admin");
  await aliceRow.getByRole("button", { name: "Rebuild search index" }).click();
  await expect(page.locator("p.alert-success")).toContainText(
    `Search index rebuild started for "alice".`,
  );

  await startSignedInAs(page, context, "alice", "browse-session");
  await expect(async () => {
    await page.goto("/files");
    await search(page, "xenocryptic");
    await expect(page.getByText(/No files or folders match/)).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: INDEX_TIMEOUT });
  await expect(page.locator("li.list-row")).toHaveCount(0);
});

/**
 * Folder search results (#13). The scan records every folder in a
 * space — the ancestors of each object plus placeholder objects — so
 * seeded folders (docs/reports/..., the empty/ placeholder) become
 * searchable within one scan interval, like files.
 */
test("folder search ranks folders first and a folder result opens the folder itself", async ({
  page,
}) => {
  await search(page, "report");

  // docs/reports matches by its own name and ranks above both
  // report.pdf file name matches.
  const first = page.locator("li.list-row").first();
  await expect(first).toContainText("reports", { timeout: INDEX_TIMEOUT });
  await expect(first).toContainText("Folder");
  await expect(first).toContainText("docs");
  await expect(page.getByText("Name match")).toHaveCount(2);
  // A folder row carries no file actions.
  await expect(first.getByRole("button", { name: /Download/ })).toHaveCount(0);
  await expect(first.getByRole("button", { name: /Delete/ })).toHaveCount(0);

  await first.getByRole("link", { name: /reports/ }).click();

  // The listing of docs/reports/ itself replaced the results.
  await expect(page.getByText("Folder", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumbs" }),
  ).toContainText("reports");
  await expect(page.getByRole("link", { name: /2026/ })).toBeVisible();
});

test("an empty folder is found by name and opens to its empty state", async ({
  page,
}) => {
  await search(page, "empty");

  const row = page.locator("li.list-row", { hasText: "empty" });
  await expect(row).toBeVisible({ timeout: INDEX_TIMEOUT });
  await expect(row).toContainText("Folder");
  await expect(row).toContainText("Home");

  await row.getByRole("link", { name: /empty/ }).click();

  await expect(page.getByText(/This folder is empty/)).toBeVisible();
});

test("an own folder result shares the folder, usable at mobile and tablet widths", async ({
  page,
}) => {
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await search(page, "photos");

    const row = page.locator("li.list-row", { hasText: "photos" }).first();
    await expect(row).toContainText("Folder", { timeout: INDEX_TIMEOUT });
    await expectNoHorizontalOverflow(page);

    await row.getByRole("button", { name: "Share photos" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Share photos" });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflow(page);
    // The backdrop closes the dialog; click its corner, clear of the box.
    await page
      .getByRole("button", { name: "Close" })
      .click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Clear" }).click();
  }
});

test("a recipient finds a shared folder's root and subfolders and opens them in the share", async ({
  page,
  context,
}) => {
  await startSignedInAs(page, context, "alice", "browse-session");
  const photosShare = await page.request.post("/api/shares", {
    data: { folder: "photos/", recipientUsername: "bob" },
  });
  expect([201, 409]).toContain(photosShare.status());
  const docsShare = await page.request.post("/api/shares", {
    data: { folder: "docs/", recipientUsername: "bob" },
  });
  expect([201, 409]).toContain(docsShare.status());

  try {
    // The mount root itself matches by name and opens the share's root.
    await startSignedInAs(page, context, "bob", "bob-session");
    await search(page, "photos");
    const mount = page.locator("li.list-row", { hasText: "Shared by alice" });
    await expect(mount).toContainText("photos", { timeout: INDEX_TIMEOUT });
    await expect(mount).toContainText("Folder");
    // A recipient cannot re-share: no Share button on shared folders.
    await expect(mount.getByRole("button")).toHaveCount(0);
    await mount.getByRole("link", { name: /photos/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("Shared by alice");
    await expect(page.getByText("pic.jpg")).toBeVisible();

    // A subfolder deep inside a share opens at its mount-relative path.
    await search(page, "quarterly");
    // The content match summary.txt sits one level deeper and has no
    // Folder badge.
    const deep = page
      .locator("li.list-row", { hasText: "Folder" })
      .filter({ hasText: "quarterly" });
    await expect(deep).toContainText("reports / 2026 / q1", {
      timeout: INDEX_TIMEOUT,
    });
    await expect(deep).toContainText("Shared by alice");
    await deep.getByRole("link", { name: /quarterly/ }).click();
    await expect(page.getByText("summary.txt")).toBeVisible();
  } finally {
    // Leave bob's root mounts as the other specs expect them.
    await startSignedInAs(page, context, "alice", "browse-session");
    const shares = (await (
      await page.request.get("/api/shares")
    ).json()) as ListSharesBody;
    const share = shares.outgoing.find(
      (entry) =>
        entry.folderName === "photos" && entry.recipient.username === "bob",
    );
    if (share) await page.request.delete(`/api/shares/${share.id}`);
  }
});
