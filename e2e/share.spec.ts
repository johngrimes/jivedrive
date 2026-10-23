import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Download, Page } from "@playwright/test";
import {
  chooseRowAction,
  expectNoHorizontalOverflow,
  expectSignedInAs,
  readStream,
} from "./helpers";

/** The origin the e2e server serves; overridable for scratch-port runs. */
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:5173";

/** The share-link shape the modal must display (FR-001): origin + /s/ + token. */
const SHORT_LINK_PATTERN = new RegExp(
  `^${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/s/[A-Za-z0-9]{12}$`,
);

/**
 * Start signed in with the pre-seeded session (no WebAuthn ceremony; the
 * sign-in flows are covered by auth.spec) and open the space root.
 */
async function startSignedIn(
  page: Page,
  context: BrowserContext,
  cookie = "browse-session",
): Promise<void> {
  await context.addCookies([
    {
      name: "jivedrive_session",
      value: cookie,
      url: ORIGIN,
    },
  ]);
  await page.goto("/files");
  await expectSignedInAs(
    page,
    {
      "browse-session": "alice",
      "bob-session": "bob",
      "erin-session": "erin",
    }[cookie] ?? "alice",
  );
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
  await chooseRowAction(
    page.locator("li.list-row", { hasText: rowText }),
    "Share",
  );
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(rowText);
  await expect(dialog.getByLabel("Share link")).toHaveValue(SHORT_LINK_PATTERN);
  return dialog;
}

/**
 * Open a short link in a brand-new browser context (no cookies, no
 * sign-in) and return the resulting download. The caller must invoke
 * `close` after reading the download: the stream dies with its context.
 */
async function anonymousDownload(
  browser: Browser,
  link: string,
): Promise<{ download: Download; close: () => Promise<void> }> {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  const downloadPromise = anonPage.waitForEvent("download");
  // The navigation itself turns into a download (Content-Disposition:
  // attachment), which Playwright's goto reports as an error; the
  // download event is the real outcome.
  await anonPage.goto(link).catch(() => undefined);
  const download = await downloadPromise;
  return { download, close: () => anon.close() };
}

test("the modal shows a short app link with nothing about storage in it", async ({
  page,
  context,
}) => {
  await startSignedIn(page, context);
  // readme.md sorts onto the second page of the seeded listing.
  await page.getByRole("button", { name: "Load more" }).click();
  const dialog = await openShare(page, "readme.md");

  const link = await dialog.getByLabel("Share link").inputValue();
  expect(link).toMatch(SHORT_LINK_PATTERN);
  // FR-003: no storage provider host, bucket, prefix or object key.
  expect(link).not.toContain("X-Amz");
  expect(link).not.toContain("5299");
  expect(link).not.toContain("jivedrive-prod");
  expect(link).not.toContain("users/alice");
  expect(link).not.toContain("readme");

  // The dialog shows when the link will expire.
  await expect(dialog.getByText(/Link expires \d/)).toBeVisible();

  // Copy: the clipboard receives exactly the displayed link (FR-001).
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // A different lifetime regenerates the link — still a short one.
  await dialog.getByLabel("Link expires in").selectOption({ label: "1 hour" });
  await expect(dialog.getByLabel("Share link")).toHaveValue(SHORT_LINK_PATTERN);

  // Done closes the modal.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  // The modal is fully usable on a narrow viewport (constitution VI).
  await openShare(page, "readme.md");
  await page.setViewportSize({ width: 375, height: 667 });
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("an anonymous visitor downloads data.csv byte-identical with its name", async ({
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

  // US1 scenario 2: a clean context carries no cookies; opening the link
  // downloads the file with its original filename (FR-002).
  const { download, close } = await anonymousDownload(browser, link);
  expect(download.suggestedFilename()).toBe("data.csv");
  const content = await readStream(await download.createReadStream());
  await close();
  expect(content.toString()).toBe("a,b,c\n1,2,3");
});

test("an anonymous visitor downloads a file whose name has spaces and special characters", async ({
  page,
  context,
  browser,
}: {
  page: Page;
  context: BrowserContext;
  browser: Browser;
}) => {
  await startSignedIn(page, context);
  await page.getByRole("link", { name: "docs" }).click();
  const dialog = await openShare(page, "my file #1?.txt");
  const link = await dialog.getByLabel("Share link").inputValue();
  // The short link itself carries no trace of the awkward name (FR-003).
  expect(link).toMatch(SHORT_LINK_PATTERN);

  const { download, close } = await anonymousDownload(browser, link);
  // The app sends the original name verbatim in Content-Disposition;
  // the browser itself replaces the one character it cannot use in a
  // filename ("?") with "_", which no server can prevent.
  expect(download.suggestedFilename()).toBe("my file #1_.txt");
  const content = await readStream(await download.createReadStream());
  await close();
  expect(content.toString()).toBe("special file content");
});

test("a link from a shared mount downloads for an anonymous visitor", async ({
  page,
  context,
  browser,
}: {
  page: Page;
  context: BrowserContext;
  browser: Browser;
}) => {
  // Idempotent setup: alice shares `docs` with erin via the API
  // (201 first time, 409 when a previous run created it). erin is a
  // dedicated seeded user no spec removes; bob is not usable here
  // because share-folder.spec's US5 deletes him and the suite runs
  // fullyParallel. docs (not projects) so this share never interferes
  // with share-folder.spec's recipient assertions about projects.
  await startSignedIn(page, context);
  const shareRes = await page.request.post("/api/shares", {
    data: { folder: "docs/", recipientUsername: "erin" },
  });
  expect([201, 409]).toContain(shareRes.status());

  // Erin opens the mount and shares notes.txt from it (US1 scenario 3).
  await context.clearCookies();
  await startSignedIn(page, context, "erin-session");
  await page
    .locator("li.list-row", { hasText: "Shared by alice" })
    .getByRole("link")
    .click();
  const dialog = await openShare(page, "notes.txt");
  const link = await dialog.getByLabel("Share link").inputValue();

  const { download, close } = await anonymousDownload(browser, link);
  expect(download.suggestedFilename()).toBe("notes.txt");
  const content = await readStream(await download.createReadStream());
  await close();
  expect(content.toString()).toBe("hello from notes");
});

test("out-of-scope and unknown-space share requests are refused with no link", async ({
  page,
  context,
}) => {
  // US1 scenario 4: the existing error codes, end to end.
  await startSignedIn(page, context);

  const outOfScope = await page.request.post("/api/files/share-url", {
    data: { key: "users/bob/a.txt" },
  });
  expect(outOfScope.status()).toBe(400);
  expect(await outOfScope.json()).toMatchObject({ code: "out_of_scope" });

  const unknownSpace = await page.request.post("/api/files/share-url", {
    data: { space: "shared:no-such-share", key: "a.txt" },
  });
  expect(unknownSpace.status()).toBe(404);
});

test("an expired link shows the friendly dead-link page at every width", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // US2 scenarios 2-3: an anonymous visitor opening the seeded expired
  // link sees the styled expiry page — no JSON error, no SPA crash —
  // usable at mobile, tablet and desktop widths (constitution VI).
  const anon = await browser.newContext();
  const page = await anon.newPage();
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const res = await page.goto("/s/exp1redshare");
    expect(res?.status()).toBe(410);
    await expect(
      page.getByRole("heading", { name: /expired or does not exist/i }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await anon.close();
});

test("an unknown token shows the same dead-link page as an expired one", async ({
  browser,
}: {
  browser: Browser;
}) => {
  // FR-005: a token that was never issued is indistinguishable from an
  // expired one — the same 410 status and the same wording.
  const anon = await browser.newContext();
  const page = await anon.newPage();
  const res = await page.goto("/s/zzzzzzzzzzz9");
  expect(res?.status()).toBe(410);
  await expect(
    page.getByRole("heading", { name: /expired or does not exist/i }),
  ).toBeVisible();
  await anon.close();
});
