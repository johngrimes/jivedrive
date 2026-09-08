import {
  expectNoHorizontalOverflow,
  expectSignedInAs,
  readStream,
} from "./helpers";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * The outgoing share shape returned by GET /api/shares (contract
 * `ShareOutgoing`).
 */
interface ShareOutgoingBody {
  id: string;
  folder: string;
  folderName: string;
  recipient: { id: string; username: string };
  createdAt: string;
}

/** The response of GET /api/shares (contract `Share` list shape). */
interface ListSharesBody {
  incoming: unknown[];
  outgoing: ShareOutgoingBody[];
}

/** The viewport widths of the mobile-first responsive sweep (constitution VI). */
const RESPONSIVE_VIEWPORTS = [
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

/**
 * Start signed in as alice with the pre-seeded browse-session cookie and
 * open the space root.
 *
 * @param page - the page
 * @param context - the browser context
 */
async function startSignedInAsAlice(
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

// The specs in this file share one in-memory server per run, so the tests
// run sequentially (never interleaved). Each test creates its own state:
// later user stories (US2-US5) revoke or delete shares, so no test may
// depend on a share created by an earlier one. CI retries re-run a failed
// test alone against a freshly seeded server, so each test must be
// self-sufficient from seed state.
test.describe.configure({ mode: "serial" });

test("US1: alice shares the projects folder with bob via the share dialog", async ({
  page,
  context,
}) => {
  await startSignedInAsAlice(page, context);

  // The seeded root has 11 entries with a page size of 5, and the mock
  // returns folders and files in key order, so `projects` sorts onto the
  // second page. One Load more reveals it.
  await page.getByRole("button", { name: "Load more" }).click();
  const folderRow = page.locator("li.list-row", { hasText: "projects" });
  await expect(folderRow).toBeVisible();

  // R13: the folder row carries a share-folder button; it opens the
  // share dialog for exactly this folder.
  await folderRow.getByRole("button", { name: "Share projects" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("projects");

  // R4: search "bo" finds bob (case-insensitive substring); the picker
  // exposes only usernames.
  await dialog.getByLabel("Search users").fill("bo");
  const bobResult = dialog.getByRole("button", { name: "bob", exact: true });
  await expect(bobResult).toBeVisible();
  await bobResult.click();

  // Confirm the share: one search and one confirmation (SC-001).
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  // US1 sc.1/sc.3: the dialog lists bob as a recipient with a share date.
  await expect(dialog.getByText("bob", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Shared \d/)).toBeVisible();

  // FR-018: the projects row at the root shows a visible "Shared" chip.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(folderRow.getByText("Shared", { exact: true })).toBeVisible();

  // The API (same cookie jar as the page) reports the outgoing share with
  // the contract shape: folder normalised, recipient identity only.
  const res = await page.request.get("/api/shares");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ListSharesBody;
  const share = body.outgoing.find(
    (entry) =>
      entry.folderName === "projects" && entry.recipient.username === "bob",
  );
  expect(share).toBeDefined();
  expect(share?.folder).toBe("projects/");
  expect(share?.recipient.username).toBe("bob");
  expect(typeof share?.createdAt).toBe("string");
});
test("US2: bob browses and downloads the projects folder shared by alice", async ({
  page,
  context,
}) => {
  // Idempotent setup: create the alice -> bob share of `projects` via
  // the API. 409 already_shared is success when the US1 test already
  // created the share in this run; on a CI retry re-running this test
  // alone against a freshly seeded server, the create succeeds instead.
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "projects/", recipientUsername: "bob" },
  });
  expect([201, 409]).toContain(shareRes.status());

  // Switch to bob and load his space root.
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "bob-session",
      url: "http://localhost:5173",
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(page, "bob");

  // FR-008 (US2 sc.6): the mount appears ALONGSIDE bob's own same-named
  // folder; the label disambiguates the two rows.
  const projectsRows = page.locator("li.list-row", { hasText: "projects" });
  await expect(projectsRows).toHaveCount(2);
  const mountRow = projectsRows.filter({ hasText: "Shared by alice" });
  await expect(mountRow).toBeVisible();
  await expect(mountRow).toContainText("Shared by alice");
  // FR-015: the received row carries no share button, while bob's own
  // same-named folder row keeps its share action.
  await expect(
    mountRow.getByRole("button", { name: "Share projects" }),
  ).toHaveCount(0);
  const ownRow = projectsRows.filter({ hasNotText: "Shared by alice" });
  await expect(ownRow).toHaveCount(1);
  await expect(
    ownRow.getByRole("button", { name: "Share projects" }),
  ).toBeVisible();

  // Open the mount: alice's contents list (plan.txt, docs/).
  await mountRow.getByRole("link").click();
  await expect(page).toHaveURL(/space=shared/);
  await expect(page.getByText("plan.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "docs" })).toBeVisible();
  // The mount root shows the sharer (breadcrumb label, R12).
  await expect(
    page.getByText("Shared by alice", { exact: true }),
  ).toBeVisible();
  // US3: the mount is writable — the upload control is present and file
  // rows carry delete actions (T027), both scoped to the sharer's folder.
  await expect(page.getByText("Upload file", { exact: true })).toBeVisible();
  await expect(
    page
      .locator("li.list-row", { hasText: "plan.txt" })
      .getByRole("button", { name: "Delete" }),
  ).toBeVisible();

  // Navigate into docs/ and download report.pdf (US2 sc.1/sc.2).
  await page.getByRole("link", { name: "docs" }).click();
  await expect(page.getByText("report.pdf", { exact: true })).toBeVisible();
  const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(breadcrumbs).toContainText("projects");
  await expect(breadcrumbs).toContainText("docs");
  await expect(breadcrumbs).toContainText("Shared by alice");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const download = await downloadPromise;
  const content = await readStream(await download.createReadStream());
  expect(content.toString()).toBe("%PDF-1.4 report");

  // Home returns to bob's own root: his own file and the labelled mount
  // are both back.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByText("own-note.txt", { exact: true })).toBeVisible();
  await expect(projectsRows).toHaveCount(2);
});

test("US3: bob uploads, overwrites and deletes a file in the projects folder shared by alice", async ({
  page,
  context,
  playwright,
}) => {
  // A dedicated API client for alice: page.request shares the browser
  // context's cookie jar, which switches to bob below, so alice-side
  // assertions go through their own cookie-carrying client instead.
  const aliceApi = await playwright.request.newContext({
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:5173",
    extraHTTPHeaders: { cookie: "jivedrive_session=browse-session" },
  });
  try {
    // Idempotent setup: create the alice -> bob share of `projects` via
    // the API. 409 already_shared is success when an earlier test in this
    // run created the share; on a CI retry against a freshly seeded
    // server the create succeeds instead.
    const shareRes = await aliceApi.post("/api/shares", {
      data: { folder: "projects/", recipientUsername: "bob" },
    });
    expect([201, 409]).toContain(shareRes.status());

    // Retry-safe: remove any notes.txt left behind by a failed earlier
    // attempt so this test always starts from seed state (US3 sc.1).
    const seeded = await aliceApi.get("/api/files?prefix=projects&space=own");
    expect(seeded.status()).toBe(200);
    const seededBody = (await seeded.json()) as {
      folders: string[];
      files: Array<{ name: string }>;
    };
    if (seededBody.files.some((file) => file.name === "notes.txt")) {
      const cleanup = await aliceApi.delete(
        `/api/files?key=${encodeURIComponent(
          "users/alice/projects/notes.txt",
        )}&space=own`,
      );
      expect(cleanup.status()).toBe(204);
    }

    // Switch to bob and open the mount.
    await context.addCookies([
      {
        name: "jivedrive_session",
        value: "bob-session",
        url: "http://localhost:5173",
      },
    ]);
    await page.goto("/files");
    await expectSignedInAs(page, "bob");
    const mountRow = page
      .locator("li.list-row", { hasText: "projects" })
      .filter({ hasText: "Shared by alice" });
    await expect(mountRow).toBeVisible();
    await mountRow.getByRole("link").click();
    await expect(page).toHaveURL(/space=shared/);

    // US3 sc.1: bob uploads notes.txt into the shared folder.
    const fileName = "notes.txt";
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("project notes v1\n"),
    });
    // Visibility of system status (constitution V): an uploading
    // indicator with progress, then explicit success feedback.
    await expect(page.getByRole("progressbar")).toBeVisible();
    await expect(
      page.getByText(`Uploaded ${fileName}`, { exact: true }),
    ).toBeVisible();
    const row = page.locator("li.list-row", { hasText: fileName });
    await expect(row).toBeVisible();

    // The object landed under alice's prefix: her own listing of
    // projects (the single source of truth, quickstart scenario 3) shows
    // notes.txt too.
    const afterUpload = await aliceApi.get(
      "/api/files?prefix=projects&space=own",
    );
    expect(afterUpload.status()).toBe(200);
    const afterUploadBody = (await afterUpload.json()) as {
      files: Array<{ name: string }>;
    };
    expect(afterUploadBody.files.some((file) => file.name === fileName)).toBe(
      true,
    );

    // US3 sc.2/sc.3: a second upload without consent is refused (409)
    // and the confirmation dialog appears; Replace retries with
    // overwrite consent and replaces the content.
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("project notes v2\n"),
    });
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(fileName);
    await expect(dialog).toContainText("already exists");
    await dialog.getByRole("button", { name: "Replace" }).click();
    await expect(dialog).toHaveCount(0);
    // The success feedback only appears once the replacement body has
    // actually been PUT to storage, so it gates the download assertion.
    await expect(
      page.getByText(`Uploaded ${fileName}`, { exact: true }),
    ).toBeVisible();
    await expect(row).toBeVisible();

    // The replacement content is what the sharer's object now holds:
    // downloading from the mount returns v2.
    const downloadPromise = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download" }).click();
    const download = await downloadPromise;
    const content = await readStream(await download.createReadStream());
    expect(content.toString()).toBe("project notes v2\n");

    // US3 sc.4: bob deletes notes.txt; it disappears from the mount...
    await row.getByRole("button", { name: "Delete" }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toContainText(fileName);
    await deleteDialog.getByRole("button", { name: "Delete" }).click();
    await expect(deleteDialog).toHaveCount(0);
    await expect(
      page.locator("li.list-row", { hasText: fileName }),
    ).toHaveCount(0);

    // ...and from alice's own listing: both views agree.
    const afterDelete = await aliceApi.get(
      "/api/files?prefix=projects&space=own",
    );
    expect(afterDelete.status()).toBe(200);
    const afterDeleteBody = (await afterDelete.json()) as {
      files: Array<{ name: string }>;
    };
    expect(afterDeleteBody.files.some((file) => file.name === fileName)).toBe(
      false,
    );
  } finally {
    await aliceApi.dispose();
  }
});
test("US4: alice revokes bob's share; the mount disappears and every request 404s", async ({
  page,
  context,
  playwright,
}) => {
  // A dedicated API client for alice: page.request shares the browser
  // context's cookie jar, which switches to bob below, so alice-side
  // assertions go through their own cookie-carrying client instead.
  const aliceApi = await playwright.request.newContext({
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:5173",
    extraHTTPHeaders: { cookie: "jivedrive_session=browse-session" },
  });
  try {
    // Idempotent setup: ensure the alice -> bob share of `projects`
    // exists. 409 already_shared is success when an earlier US1-US3 test
    // in this run created the row; on a CI retry against a freshly
    // seeded server the create succeeds instead. This test then revokes
    // that exact row, so it is self-sufficient from seed state.
    const shareRes = await aliceApi.post("/api/shares", {
      data: { folder: "projects/", recipientUsername: "bob" },
    });
    expect([201, 409]).toContain(shareRes.status());

    // Capture the share id this test is about to revoke.
    const listRes = await aliceApi.get("/api/shares");
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as ListSharesBody;
    const share = body.outgoing.find(
      (entry) =>
        entry.folderName === "projects" && entry.recipient.username === "bob",
    );
    expect(share).toBeDefined();
    const revokedShareId = share!.id;

    // As alice, open the share dialog on projects (it sits on the second
    // page of the seeded root, as in US1).
    await startSignedInAsAlice(page, context);
    await page.getByRole("button", { name: "Load more" }).click();
    const folderRow = page.locator("li.list-row", { hasText: "projects" });
    await expect(folderRow).toBeVisible();
    await folderRow.getByRole("button", { name: "Share projects" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("bob", { exact: true })).toBeVisible();

    // US4 sc.1: revoke bob's share; the recipient list updates and no
    // longer shows bob.
    await dialog.getByRole("button", { name: "Revoke share for bob" }).click();
    await expect(dialog.getByText("bob", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByText(
        "No recipients yet. Search for a user above to share this folder.",
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // US4 sc.2: as bob, the mount is gone from the root on the next
    // load; his own same-named folder remains (no "Shared by alice"
    // label anywhere).
    await context.addCookies([
      {
        name: "jivedrive_session",
        value: "bob-session",
        url: "http://localhost:5173",
      },
    ]);
    await page.goto("/files");
    await expectSignedInAs(page, "bob");
    const projectsRows = page.locator("li.list-row", { hasText: "projects" });
    await expect(projectsRows).toHaveCount(1);
    await expect(
      projectsRows.filter({ hasText: "Shared by alice" }),
    ).toHaveCount(0);

    // US4 sc.3: a direct request against the former shared space is
    // refused with 404.
    const filesRes = await page.request.get(
      `/api/files?space=${encodeURIComponent(`shared:${revokedShareId}`)}`,
    );
    expect(filesRes.status()).toBe(404);

    // The owner's listing no longer shows the share (FR-013).
    const afterRes = await aliceApi.get("/api/shares");
    expect(afterRes.status()).toBe(200);
    const afterBody = (await afterRes.json()) as ListSharesBody;
    expect(
      afterBody.outgoing.some((entry) => entry.id === revokedShareId),
    ).toBe(false);

    // T030: opening the old shared URL as bob surfaces the explicit
    // revocation message (the mount-relative page error, not a generic
    // failure), and the listing offers Retry.
    await page.goto(`/files?space=shared:${revokedShareId}`);
    await expect(
      page.getByText(
        "This shared folder is no longer available: the share was revoked.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  } finally {
    await aliceApi.dispose();
  }
});

test("responsive: the share dialog is usable with no overflow at 375, 768 and 1280 px", async ({
  page,
  context,
}) => {
  // Idempotent setup: ensure the alice -> bob share of `projects`
  // exists. 409 already_shared is success when an earlier test in this
  // run created the row; on a CI retry against a freshly seeded server
  // the create succeeds instead (US2 pattern).
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "projects/", recipientUsername: "bob" },
  });
  expect([201, 409]).toContain(shareRes.status());

  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/files");
    await expectSignedInAs(page, "alice");

    // The projects row sits on the second page of the seeded root (11
    // entries, page size 5); one Load more reveals it (US1 pattern).
    await page.getByRole("button", { name: "Load more" }).click();
    const folderRow = page.locator("li.list-row", { hasText: "projects" });
    await expect(folderRow).toBeVisible();
    await folderRow.getByRole("button", { name: "Share projects" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // The recipient search is usable: typing "bo" surfaces bob in the
    // results list, and picking him fills the input (FR-006, R4).
    const searchInput = dialog.getByLabel("Search users");
    await searchInput.fill("bo");
    const bobResult = dialog.getByRole("button", {
      name: "bob",
      exact: true,
    });
    await expect(bobResult).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await bobResult.click();
    await expect(searchInput).toHaveValue("bob");
    await expect(bobResult).toHaveCount(0);

    // The recipient row (bob, from the idempotent setup) renders with a
    // touch-target-sized revoke button (min-h-11 -> >= 44px) and the
    // open dialog never scrolls horizontally (constitution VI).
    const recipientRow = dialog.locator("li.list-row", { hasText: "bob" });
    await expect(recipientRow).toBeVisible();
    const revoke = dialog.getByRole("button", {
      name: "Revoke share for bob",
    });
    await expect(revoke).toBeVisible();
    const box = await revoke.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test("responsive: bob's mount view is usable with no overflow at 375, 768 and 1280 px", async ({
  page,
  context,
}) => {
  // Idempotent setup: ensure the alice -> bob share of `projects`
  // exists (409 already_shared is success when an earlier test in this
  // run created the row), then switch to bob (US2 pattern).
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "browse-session",
      url: "http://localhost:5173",
    },
  ]);
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "projects/", recipientUsername: "bob" },
  });
  expect([201, 409]).toContain(shareRes.status());
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: "bob-session",
      url: "http://localhost:5173",
    },
  ]);

  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/files");
    await expectSignedInAs(page, "bob");

    // The mount renders alongside bob's own same-named folder, labelled
    // with the sharer (FR-008), and the root never scrolls horizontally.
    const mountRow = page
      .locator("li.list-row", { hasText: "projects" })
      .filter({ hasText: "Shared by alice" });
    await expect(mountRow).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Open the mount: the breadcrumbs carry the sharer label and the
    // listing shows the sharer's contents (plan.txt, docs/).
    await mountRow.getByRole("link").click();
    await expect(page).toHaveURL(/space=shared/);
    const breadcrumbs = page.getByRole("navigation", {
      name: "Breadcrumbs",
    });
    await expect(breadcrumbs).toContainText("Shared by alice");
    await expect(page.getByText("plan.txt", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "docs" })).toBeVisible();

    // The read/write controls are usable: upload, download and delete
    // are all present, and the row actions keep 44px+ touch targets
    // (min-h-11, constitution VI).
    await expect(page.getByText("Upload file", { exact: true })).toBeVisible();
    const planRow = page.locator("li.list-row", { hasText: "plan.txt" });
    for (const action of ["Download", "Delete"]) {
      const button = planRow.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);

    // Navigate into the subfolder: the breadcrumb trail keeps the mount
    // name and the sharer label (R12) and still fits the viewport.
    await page.getByRole("link", { name: "docs" }).click();
    await expect(page.getByText("report.pdf", { exact: true })).toBeVisible();
    await expect(breadcrumbs).toContainText("projects");
    await expect(breadcrumbs).toContainText("docs");
    await expect(breadcrumbs).toContainText("Shared by alice");
    await expectNoHorizontalOverflow(page);

    // At the narrowest width the download control actually works: the
    // mount-relative presigned URL returns the sharer's bytes (US2 sc.2).
    if (viewport.width === 375) {
      const downloadPromise = page.waitForEvent("download");
      await page
        .locator("li.list-row", { hasText: "report.pdf" })
        .getByRole("button", { name: "Download" })
        .click();
      const download = await downloadPromise;
      const content = await readStream(await download.createReadStream());
      expect(content.toString()).toBe("%PDF-1.4 report");
    }
  }
});

test("US5: admin deletes bob; alice's mount, share dialog and /api/shares show no trace of bob", async ({
  page,
  context,
  playwright,
}) => {
  // Dedicated API clients so the alice/admin/bob requests survive the
  // page's cookie-jar switches (pattern from US3/US4). Alice and bob
  // carry their own sessions; the admin uses the seeded admin-session.
  const aliceApi = await playwright.request.newContext({
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:5173",
    extraHTTPHeaders: { cookie: "jivedrive_session=browse-session" },
  });
  const bobApi = await playwright.request.newContext({
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:5173",
    extraHTTPHeaders: { cookie: "jivedrive_session=bob-session" },
  });
  const adminApi = await playwright.request.newContext({
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:5173",
    extraHTTPHeaders: { cookie: "jivedrive_session=admin-session" },
  });
  try {
    // Self-sufficient setup in both directions (US5 sc.1): alice shares
    // projects with bob (the outgoing/dialog direction) and bob shares
    // projects with alice (the incoming/mount direction). 409
    // already_shared is success when an earlier US1-US4 test in this run
    // created the alice row; on a CI retry against a freshly seeded
    // server the creates succeed instead.
    const aliceShare = await aliceApi.post("/api/shares", {
      data: { folder: "projects/", recipientUsername: "bob" },
    });
    expect([201, 409]).toContain(aliceShare.status());
    const bobShare = await bobApi.post("/api/shares", {
      data: { folder: "projects/", recipientUsername: "alice" },
    });
    const bobAlive = [201, 409].includes(bobShare.status());

    // As alice, the "Shared by bob" mount exists BEFORE the deletion:
    // it proves the row that must disappear (FR-008, US5 sc.2). Skipped
    // when bob is already gone (failed retry deleting him mid-run).
    if (bobAlive) {
      await startSignedInAsAlice(page, context);
      const mountRow = page
        .locator("li.list-row", { hasText: "projects" })
        .filter({ hasText: "Shared by bob" });
      await expect(mountRow).toBeVisible();
    }

    // Resolve bob's id from the admin user list, then delete him. The
    // removal is idempotent (204 even for an unknown id); a refusal is
    // acceptable when the post-conditions already hold (a failed retry
    // may have deleted bob already).
    const usersRes = await adminApi.get("/api/admin/users");
    expect(usersRes.status()).toBe(200);
    const usersBody = (await usersRes.json()) as {
      users: Array<{ id: string; username: string }>;
    };
    const bobUser = usersBody.users.find((user) => user.username === "bob");
    if (bobUser) {
      const delRes = await adminApi.delete(
        `/api/admin/users?id=${encodeURIComponent(bobUser.id)}`,
      );
      expect([204, 400, 404]).toContain(delRes.status());
    }

    // FR-014/SC-005: as alice, reload the root — no mount row references
    // bob anymore (her own same-named projects folder remains).
    await startSignedInAsAlice(page, context);
    await expect(
      page.locator("li.list-row", { hasText: "Shared by bob" }),
    ).toHaveCount(0);

    // Her share dialog on projects no longer lists bob as a recipient
    // (the projects row sits on the second page, as in US1).
    await page.getByRole("button", { name: "Load more" }).click();
    const folderRow = page.locator("li.list-row", { hasText: "projects" });
    await expect(folderRow).toBeVisible();
    await folderRow.getByRole("button", { name: "Share projects" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("bob", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByText(
        "No recipients yet. Search for a user above to share this folder.",
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // API check: GET /api/shares as alice shows no bob in either
    // direction — the e2e stand-in for the direct DB check T032 performs
    // at the route level (SC-005).
    const sharesRes = await aliceApi.get("/api/shares");
    expect(sharesRes.status()).toBe(200);
    const sharesBody = (await sharesRes.json()) as ListSharesBody;
    expect(
      sharesBody.outgoing.some((entry) => entry.recipient.username === "bob"),
    ).toBe(false);
    const incoming = sharesBody.incoming as Array<{
      sharer: { username: string };
    }>;
    expect(incoming.some((entry) => entry.sharer.username === "bob")).toBe(
      false,
    );

    // Bonus (cascade check): bob's own session is gone with his account,
    // so /auth/me reports no user for his cookie (admin.spec.ts
    // convention: 200 with user null).
    const me = await bobApi.get("/auth/me");
    expect(me.status()).toBe(200);
    const meBody = (await me.json()) as { user: unknown };
    expect(meBody.user).toBeNull();
  } finally {
    await aliceApi.dispose();
    await bobApi.dispose();
    await adminApi.dispose();
  }
});
