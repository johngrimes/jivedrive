import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import {
  downloadFromPopup,
  enableVirtualAuthenticator,
  expectNoHorizontalOverflow,
  expectSignedInAs,
  readStream,
} from "./helpers";

/**
 * A long username at the data-model maximum (32 chars, see
 * `validateUsername` in backend/src/db/repository.ts) and its pre-seeded
 * session. The navbar must truncate it with an ellipsis at 375px instead of
 * overflowing (FR-003, US1 sc.4). Seeded in e2eServer.ts.
 */
const LONG_USERNAME = "this-username-is-really-long";

/** The pre-seeded e2e session cookies (same pattern as e2e/browse.spec.ts). */
const ADMIN_SESSION_COOKIE = {
  name: "jivedrive_session",
  value: "admin-session",
  url: "http://localhost:5173",
};
const BROWSE_SESSION_COOKIE = {
  name: "jivedrive_session",
  value: "browse-session",
  url: "http://localhost:5173",
};
const LONG_USERNAME_SESSION_COOKIE = {
  name: "jivedrive_session",
  value: "longname-session",
  url: "http://localhost:5173",
};

/** The 375px phone viewport used across the mobile assertions. */
/**
 * Short share links: `<app origin>/s/<12-char base62 token>` (spec 009,
 * FR-001). Same hardcoded origin as the session cookies above.
 */
const SHORT_LINK_PATTERN = /^http:\/\/localhost:5173\/s\/[A-Za-z0-9]{12}$/;

const MOBILE_VIEWPORT = { width: 375, height: 667 };

/**
 * Assert that the element truncates its text with an ellipsis: the CSS must
 * be nowrap + overflow hidden + text-overflow ellipsis, and the text must
 * actually overflow the element's box (scrollWidth > clientWidth).
 *
 * @param page - the page
 * @param locator - the element whose truncation to assert
 */
async function expectTruncated(page: Page, locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      overflowX: style.overflowX,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
  expect(metrics.textOverflow).toBe("ellipsis");
  expect(metrics.whiteSpace).toBe("nowrap");
  expect(metrics.overflowX).toBe("hidden");
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
}

test.describe("User Story 1 - responsive navigation", () => {
  test("a long username truncates with an ellipsis at 375px without horizontal overflow", async ({
    page,
    context,
  }) => {
    await context.addCookies([LONG_USERNAME_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, LONG_USERNAME);
    await expectNoHorizontalOverflow(page);

    // The sign-in state stays visible (constitution V) while the username
    // ellipsizes inside the header button instead of pushing the page wide
    // (FR-003, US1 sc.4).
    const signInState = page.getByRole("button", {
      name: LONG_USERNAME,
      exact: true,
    });
    await expectTruncated(page, signInState);
  });

  test("a signed-out visitor at 375px sees the brand and Sign in link, no hamburger and no drawer", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "JiveDrive" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0,
    );
    await expect(page.locator(".drawer-side")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("User Story 2 - file browser rendered for mobile, with octicons", () => {
  /** The seeded root file used as the mobile file-row fixture. */
  const FILE_ROW_TEXT = "budget.xlsx";

  /**
   * Start signed in as alice with the pre-seeded session and open /files.
   *
   * @param page - the page
   * @param context - the browser context
   */
  async function startSignedIn(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    await context.addCookies([BROWSE_SESSION_COOKIE]);
    await page.goto("/files");
    await expectSignedInAs(page, "alice");
  }

  test("at 375px a file row shows icon-only action buttons", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const row = page.locator("li.list-row", { hasText: FILE_ROW_TEXT });
    await expect(row).toBeVisible();

    // FR-007 / US2 sc.1: the actions are buttons with accessible names
    // identical to today's text labels, icon-only below sm (the label span
    // is not visible, the icon svg is).
    for (const action of ["Download", "Share", "Delete"]) {
      const button = row.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toBeVisible();
      await expect(button.getByText(action, { exact: true })).toBeHidden();
    }

    // Octicons replaced the emoji (FR-004): no 📁/📄 anywhere in the rows.
    await expect(page.locator("ul.list")).not.toContainText(["📁", "📄"]);
    await expectNoHorizontalOverflow(page);
  });

  test("file action buttons are at least 44px tall at 375px", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const row = page.locator("li.list-row", { hasText: FILE_ROW_TEXT });
    await expect(row).toBeVisible();

    // FR-008 / US2 sc.1: every action control keeps a touch target at
    // least 44px tall (the daisyUI btn sizing mechanism).
    for (const action of ["Download", "Share", "Delete"]) {
      const button = row.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("tapping the download icon at 375px downloads the file", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // Navigate into docs/ (folders sort first, so the link is on page 1).
    await page.getByRole("link", { name: /docs/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("docs");
    await expect(page.getByText("notes.txt")).toBeVisible();

    // US2 sc.4: the icon button triggers the same download the text link
    // did: the browser opens the presigned URL in a new window and gets
    // the bytes there.
    const download = await downloadFromPopup(page, () =>
      page
        .locator("li.list-row", { hasText: "notes.txt" })
        .getByRole("button", { name: "Download" })
        .click(),
    );
    const content = await readStream(await download.createReadStream());
    expect(download.suggestedFilename()).toBe("notes.txt");
    expect(download.url()).toContain("localhost:5299");
    expect(download.url()).toContain("X-Amz-Signature");
    expect(content.toString()).toBe("hello from notes");
  });

  test("at 768px actions show icon and text labels", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize({ width: 768, height: 1024 });
    const row = page.locator("li.list-row", { hasText: FILE_ROW_TEXT });
    await expect(row).toBeVisible();

    // US2 sc.2 / FR-007: actions show the icon AND the visible text label.
    const download = row.getByRole("button", { name: "Download" });
    await expect(download).toBeVisible();
    await expect(download.locator("svg")).toBeVisible();
    await expect(download.getByText("Download", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a folder row shows a folder octicon, navigates on tap, and never shows file actions", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // US2 sc.3 / US1 (R13): folders stay links (they navigate), carry the
    // folder octicon, and expose exactly one action - the share-folder
    // button - never the file actions (Download/Share/Delete).
    const folderRow = page.locator("li.list-row", { hasText: "docs" });
    await expect(folderRow.getByRole("link", { name: "docs" })).toBeVisible();
    await expect(
      folderRow.getByRole("link", { name: "docs" }).locator("svg"),
    ).toBeVisible();
    await expect(folderRow.getByRole("button")).toHaveCount(1);
    await expect(
      folderRow.getByRole("button", { name: "Share docs" }),
    ).toBeVisible();
    await expect(
      folderRow.getByRole("button", { name: /^(Download|Share|Delete)$/ }),
    ).toHaveCount(0);
    await expect(folderRow).not.toContainText("📁");

    // Tapping the folder navigates into it.
    await folderRow.getByRole("link", { name: "docs" }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("docs");
    await expect(page.getByText("notes.txt")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the toolbar at 375px shows the item count and a usable upload button, no overflow", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // US2 sc.5: both the item count and the upload button are visible.
    await expect(page.getByText("5 items")).toBeVisible();
    const uploadButton = page.getByText("Upload file", { exact: true });
    await expect(uploadButton).toBeVisible();
    await expect(uploadButton.locator("svg")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // And usable: a file upload actually starts from the toolbar at 375px.
    // Upload into photos/ (not the root or docs/): the root item counts are
    // asserted by browse.spec, and docs/ must stay within one page for
    // upload.spec. The name is unique per attempt so a Playwright retry
    // (CI sets retries=2) never hits the overwrite confirmation. The "0-"
    // prefix sorts the new file onto photos/' first page: the seeded
    // photos/ objects plus uploads from the other tests in this spec can
    // push photos/ past the 5-item page size, and the listing refresh
    // after an upload only returns the first page.
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByRole("link", { name: /photos/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("photos");
    const fileName = `0-mobile upload check ${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("mobile upload check"),
    });
    await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();
    await expect(
      page.locator("li.list-row", { hasText: fileName }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("long file names truncate at 375px with no horizontal scroll", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // US2 sc.6 / edge case: names with spaces and special characters stay
    // reachable at 375px without breaking the layout.
    await page.getByRole("link", { name: /docs/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("docs");
    const specialRow = page.locator("li.list-row", {
      hasText: "my file #1?.txt",
    });
    await expect(specialRow).toBeVisible();
    await expect(
      specialRow.getByRole("button", { name: "Download" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A genuinely long name truncates with an ellipsis inside its row
    // instead of widening the page: upload one at 375px and check the name
    // span ellipsizes (unique name per attempt, retry-safe). Upload into
    // photos/ for the same page-size reasons as the toolbar test. The
    // upload refresh returns only the first page, and uploads from the
    // other tests in this spec can push the new row (and delete-me-cancel)
    // past the 5-item page size, so load the rest of the listing first —
    // the row count is always > 5 once the upload lands, so Load more is
    // always present.
    await page.getByRole("link", { name: "Home" }).click();
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByRole("link", { name: /photos/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("photos");
    const longName = `a-very-long-file-name-that-wraps-onto-multiple-lines-when-rendered-on-a-375px-phone-screen-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: longName,
      mimeType: "text/plain",
      buffer: Buffer.from("long name"),
    });
    await expect(page.getByText(`Uploaded ${longName}`)).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    const longRow = page.locator("li.list-row", { hasText: longName });
    await expect(longRow).toBeVisible();
    const nameSpan = longRow.locator("span", { hasText: longName });
    await expect(nameSpan).toBeVisible();
    await expectTruncated(page, nameSpan);
    await expectNoHorizontalOverflow(page);
  });

  test("deep breadcrumbs wrap at 375px with no horizontal scroll", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // A deep chain: docs → reports → 2026 → q1 → quarterly (seeded in
    // e2eServer.ts as users/alice/docs/reports/2026/q1/quarterly/summary.txt;
    // the mock derives each folder level from the key). Five levels deep so
    // the trail is wider than 375px on any renderer font — the wrap below
    // must not depend on font metrics. Each folder link navigates in turn.
    for (const segment of ["docs", "reports", "2026", "q1", "quarterly"]) {
      await page.getByRole("link", { name: segment }).click();
      await expect(
        page.getByRole("navigation", { name: "Breadcrumbs" }),
      ).toContainText(segment);
    }

    // Every segment of the trail is present, from the space root down.
    const crumbs = page.getByRole("navigation", { name: "Breadcrumbs" });
    for (const segment of [
      "Home",
      "docs",
      "reports",
      "2026",
      "q1",
      "quarterly",
    ]) {
      await expect(crumbs).toContainText(segment);
    }

    // The trail wraps onto multiple lines instead of scrolling internally
    // (daisyUI's .breadcrumbs defaults to nowrap + overflow-x: auto, which
    // would clip the trail at 375px): the ul shows every crumb, its
    // content never overflows its own box ...
    const metrics = await crumbs.locator("ul").evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        height: el.getBoundingClientRect().height,
        flexWrap: style.flexWrap,
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.flexWrap).toBe("wrap");
    // ... and it really wrapped: a wrapped trail is taller than the 44px
    // minimum height of a single crumb row (min-h-11 on each crumb).
    expect(metrics.height).toBeGreaterThan(44);
    await expectNoHorizontalOverflow(page);
  });

  test("no horizontal overflow on /files at 375, 768 and 1280", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);

    // FR-009: the files screen must not scroll horizontally at any
    // supported width, in either theme.
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});

test.describe("User Story 3 - admin screen rendered for mobile, with octicons", () => {
  /**
   * A row in the invites table whose username cell contains the given text
   * exactly. Matches the username's own nested span (the cell also carries
   * stacked metadata below the breakpoints, so its accessible name is the
   * concatenation, not the bare username).
   *
   * @param page - the page
   * @param text - the exact username
   * @returns the matching row locator
   */
  function inviteRow(page: Page, text: string) {
    return page.getByRole("table", { name: "Invites" }).locator("tbody tr", {
      has: page.getByRole("cell").getByText(text, { exact: true }),
    });
  }

  /**
   * A row in the users table whose username cell contains the given text
   * exactly (see {@link inviteRow} for the nested-span rationale).
   *
   * @param page - the page
   * @param text - the exact username
   * @returns the matching row locator
   */
  function userRow(page: Page, text: string) {
    return page.getByRole("table", { name: "Users" }).locator("tbody tr", {
      has: page.getByRole("cell").getByText(text, { exact: true }),
    });
  }

  /**
   * Start signed in as the pre-seeded admin at 375px and open /admin.
   *
   * @param page - the page
   * @param context - the browser context
   */
  async function startAdmin(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "User management" }),
    ).toBeVisible();
  }

  /**
   * Create an invite through the admin UI form, mirroring admin.spec's
   * createInvite (fills Username/Bucket/Prefix, submits the form).
   *
   * @param page - the page
   * @param username - the invitee username
   */
  async function createInvite(page: Page, username: string): Promise<void> {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Bucket").fill("jivedrive-prod");
    await page.getByLabel("Prefix").fill(`users/${username}/`);
    await page.getByRole("button", { name: "Create invite link" }).click();
  }

  /**
   * A username unique to this test attempt. This block creates its own
   * invites so it never collides with admin.spec's erin/felix/grace/hazel
   * or the seeded carol/dave/ina; the Date.now() suffix plus the retry
   * suffix keeps retries (same in-memory server database) unique too.
   *
   * @param base - the readable base username
   * @param testInfo - test info providing the retry count
   * @returns the attempt-unique username
   */
  function testUsername(base: string, testInfo: TestInfo): string {
    const ts = Date.now();
    return testInfo.retry > 0
      ? `${base}-${ts}-r${testInfo.retry}`
      : `${base}-${ts}`;
  }

  test("at 375px an invite row stacks the role under the username and shows icon-only Re-send/Cancel buttons", async ({
    page,
    context,
  }, testInfo) => {
    await startAdmin(page, context);

    // A row owned by this spec: create the invite through the UI form.
    const username = testUsername("ursula", testInfo);
    await createInvite(page, username);
    const row = inviteRow(page, username);
    await expect(row).toBeVisible();

    // FR-007 / US3 sc.1: Re-send and Cancel are icon buttons with
    // accessible names identical to today's labels; below sm the text
    // label span is hidden and the octicon svg shows.
    for (const action of ["Re-send", "Cancel"]) {
      const button = row.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toBeVisible();
      await expect(button.getByText(action, { exact: true })).toBeHidden();
    }

    // FR-006 / US3 sc.1: below sm the role renders as a secondary line
    // under the username (the username cell is the row's first cell)...
    const usernameCell = row.locator("td").first();
    await expect(
      usernameCell.getByText("Member", { exact: true }),
    ).toBeVisible();

    // ... while the Role column cell itself is hidden below sm...
    await expect(
      row.getByRole("cell", { name: "Member", exact: true }),
    ).toBeHidden();

    // ... and returns to its column at sm and up (FR-006).
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      row.getByRole("cell", { name: "Member", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("an invite row stacks bucket/prefix and expiry under the username below md and returns them to their columns at 768px", async ({
    page,
    context,
  }, testInfo) => {
    await startAdmin(page, context);

    const username = testUsername("ursula", testInfo);
    await createInvite(page, username);
    const row = inviteRow(page, username);
    await expect(row).toBeVisible();

    const usernameCell = row.locator("td").first();
    const stackedPrefix = usernameCell.getByText(
      `jivedrive-prod / users/${username}/`,
      { exact: true },
    );
    const stackedExpiry = usernameCell.getByText(
      /^Expires \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );

    // FR-006 / US3 sc.2: below md (375px) bucket/prefix and expiry render
    // as secondary lines under the username while their columns are hidden.
    await expect(stackedPrefix).toBeVisible();
    await expect(stackedExpiry).toBeVisible();
    await expect(
      row.getByRole("cell", {
        name: `jivedrive-prod / users/${username}/`,
        exact: true,
      }),
    ).toBeHidden();

    // At md and up they return to their own columns and the stacked lines
    // hide again (one DOM tree, CSS-only relocation per research R3).
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(
      row.getByRole("cell", {
        name: `jivedrive-prod / users/${username}/`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      row.getByRole("cell", {
        name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
        exact: true,
      }),
    ).toBeVisible();
    await expect(stackedPrefix).toBeHidden();
    await expect(stackedExpiry).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("at 375px a user row stacks role, bucket/prefix and created under the username with a Remove icon button", async ({
    page,
    context,
  }) => {
    await startAdmin(page, context);

    // alice is a stable seeded user no other spec removes (admin.spec's
    // removal target is frank; US4 owns a dedicated user).
    const row = userRow(page, "alice");
    await expect(row).toBeVisible();

    // US3 sc.3 / FR-006: role below sm; bucket/prefix and created below md
    // all render as secondary lines in the username cell.
    const usernameCell = row.locator("td").first();
    await expect(
      usernameCell.getByText("Member", { exact: true }),
    ).toBeVisible();
    await expect(
      usernameCell.getByText("jivedrive-prod / users/alice/", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      usernameCell.getByText(/^Created \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    ).toBeVisible();

    // US3 sc.3 / FR-007: Remove is an icon button with the accessible name
    // "Remove", icon-only below sm (label hidden, octicon visible).
    const remove = row.getByRole("button", { name: "Remove" });
    await expect(remove).toBeVisible();
    await expect(remove.locator("svg")).toBeVisible();
    await expect(remove.getByText("Remove", { exact: true })).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("tapping the Remove icon at 375px opens the confirmation dialog and Cancel closes it", async ({
    page,
    context,
  }) => {
    await startAdmin(page, context);

    const row = userRow(page, "alice");
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Remove" }).click();

    // US3 sc.4: the confirmation dialog opens and behaves exactly as today
    // (same alertdialog, wording and controls).
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("alice");
    await expect(dialog).toContainText("left untouched");

    // Cancel closes it and nobody is removed (removal completes in US4).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(userRow(page, "alice")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("re-send and cancel work from the icon-only buttons at 375px", async ({
    page,
    context,
  }, testInfo) => {
    await startAdmin(page, context);

    const username = testUsername("ursula", testInfo);
    await createInvite(page, username);
    const row = inviteRow(page, username);
    await expect(row).toBeVisible();

    // The generated-link card shows the fresh invite link.
    const linkInput = page.locator("input[readonly]");
    await expect(linkInput).toHaveValue(/\/register\?token=/);
    const original = (await linkInput.inputValue()).trim();

    // US3 sc.1: re-send from the icon button issues a fresh token/link.
    await row.getByRole("button", { name: "Re-send" }).click();
    await expect(linkInput).not.toHaveValue(original);
    const resent = (await linkInput.inputValue()).trim();
    expect(resent).toMatch(/^http:\/\/localhost:5173\/register\?token=/);
    expect(resent).not.toBe(original);
    await expect(inviteRow(page, username)).toContainText("pending");

    // US3 sc.1: cancel from the icon button removes the row with feedback.
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByText(new RegExp(`Invite for "${username}" cancelled`)),
    ).toBeVisible();
    await expect(inviteRow(page, username)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("no horizontal overflow on /admin at 375, 768 and 1280", async ({
    page,
    context,
  }) => {
    await startAdmin(page, context);

    // FR-009 / US3 sc.5: the admin screen must not scroll horizontally at
    // any supported width (both tables have rows: seeded invites/users).
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(
        page.getByRole("heading", { name: "User management" }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });

  test("admin action icon buttons are at least 44px tall at 375px", async ({
    page,
    context,
  }, testInfo) => {
    await startAdmin(page, context);

    // Re-send and Cancel on an invite row owned by this spec (claimed
    // invites have no actions; the seeded invites are mutable by other
    // specs, so never measure on carol/dave/ina).
    const username = testUsername("ursula", testInfo);
    await createInvite(page, username);
    const inviteRowLocator = inviteRow(page, username);
    await expect(inviteRowLocator).toBeVisible();
    for (const action of ["Re-send", "Cancel"]) {
      const button = inviteRowLocator.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // Remove on a stable user row (alice).
    const remove = userRow(page, "alice").getByRole("button", {
      name: "Remove",
    });
    await expect(remove).toBeVisible();
    const removeBox = await remove.boundingBox();
    expect(removeBox).not.toBeNull();
    expect(removeBox!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("User Story 4 - dialogs and auth screens verified on mobile", () => {
  /**
   * Start signed in as alice with the pre-seeded session (no WebAuthn
   * ceremony) and open /files at 375px.
   *
   * @param page - the page
   * @param context - the browser context
   */
  async function startSignedIn(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    await context.addCookies([BROWSE_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "alice");
  }

  /**
   * From /files, load the rest of the root listing and open photos/ (it
   * sorts onto the second page), following delete.spec's openPhotos
   * pattern.
   *
   * @param page - the page
   * @param context - the browser context
   */
  async function openPhotos(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    await startSignedIn(page, context);
    await page.getByRole("button", { name: "Load more" }).click();
    await page.getByRole("link", { name: /photos/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("photos");
  }

  /**
   * Start signed in as the pre-seeded admin and open /admin at 375px.
   *
   * @param page - the page
   * @param context - the browser context
   */
  async function startAdmin(
    page: Page,
    context: BrowserContext,
  ): Promise<void> {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "User management" }),
    ).toBeVisible();
  }

  test("the share dialog at 375px is fully usable with octicon actions, in both themes", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);

    // data.csv sorts onto the first page of the seeded root listing, and
    // sharing only generates a read-only link (no mutation).
    await page
      .locator("li.list-row", { hasText: "data.csv" })
      .getByRole("button", { name: "Share" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("data.csv");
    await expect(dialog.getByLabel("Share link")).toHaveValue(
      SHORT_LINK_PATTERN,
    );
    const weekLink = await dialog.getByLabel("Share link").inputValue();

    // US4 sc.1: every control is visible and usable at 375px.
    const expiry = dialog.getByLabel("Link expires in");
    await expect(expiry).toBeVisible();
    await expect(dialog.getByLabel("Share link")).toBeVisible();
    const copyButton = dialog.getByRole("button", { name: "Copy link" });
    const doneButton = dialog.getByRole("button", { name: "Done" });
    await expect(copyButton).toBeVisible();
    await expect(doneButton).toBeVisible();

    // The expiry select is usable: changing it regenerates the link.
    await expiry.selectOption({ label: "1 hour" });
    await expect(dialog.getByLabel("Share link")).toHaveValue(
      SHORT_LINK_PATTERN,
    );
    expect(await dialog.getByLabel("Share link").inputValue()).not.toBe(
      weekLink,
    );

    // FR-004: copy and done carry octicons while keeping their accessible
    // names (the icons are decorative, the text still names the buttons).
    await expect(copyButton.locator("svg")).toBeVisible();
    await expect(doneButton.locator("svg")).toBeVisible();

    // Copy is usable: the clipboard receives exactly the generated link.
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://localhost:5173",
    });
    const link = await dialog.getByLabel("Share link").inputValue();
    await copyButton.click();
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(link);

    // Done closes the dialog; the open dialog never scrolls horizontally.
    await doneButton.click();
    await expect(dialog).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // SC-002: the dialog is also open at 375px in the dark theme with no
    // overflow (sharing is read-only, so the same file is safe to reopen).
    await page.emulateMedia({ colorScheme: "dark" });
    await page
      .locator("li.list-row", { hasText: "data.csv" })
      .getByRole("button", { name: "Share" })
      .click();
    await expect(dialog).toContainText("data.csv");
    await expect(dialog.getByLabel("Share link")).toHaveValue(
      SHORT_LINK_PATTERN,
    );
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the delete dialog at 375px cancels without deleting, confirms the delete, and stays scroll-free in both themes", async ({
    page,
    context,
  }) => {
    await openPhotos(page, context);

    // Self-seeded target: upload a unique file so every attempt (including
    // a CI retry after a completed delete) starts from a known state. The
    // "0-" prefix keeps it on photos/' first page after the upload refresh
    // (the listing refresh only returns the first page).
    const fileName = `0-responsive-delete-${Date.now()}.txt`;
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("delete me"),
    });
    await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();
    const row = page.locator("li.list-row", { hasText: fileName });
    await expect(row).toBeVisible();

    // US4 sc.2: the dialog opens with usable Cancel/Delete actions.
    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(fileName);
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const confirmDelete = dialog.getByRole("button", { name: "Delete" });
    await expect(cancel).toBeVisible();
    await expect(confirmDelete).toBeVisible();

    // FR-004: cancel and delete carry octicons with unchanged names.
    await expect(cancel.locator("svg")).toBeVisible();
    await expect(confirmDelete.locator("svg")).toBeVisible();

    // Cancel closes the dialog without any request: the row stays.
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Confirming deletes: reopen the dialog, click Delete, the row
    // disappears from the listing.
    await row.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toContainText(fileName);
    await confirmDelete.click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);

    // SC-002: the dialog is also open at 375px in the dark theme with no
    // overflow. 0-responsive-overwrite.txt is a stable object no spec ever
    // deletes (the overwrite flow only replaces its content) and its "0-"
    // prefix keeps it on photos/' first page even as the other tests in
    // this spec accumulate uploads; Cancel leaves it untouched.
    await page.emulateMedia({ colorScheme: "dark" });
    const stableRow = page.locator("li.list-row", {
      hasText: "0-responsive-overwrite.txt",
    });
    await expect(stableRow).toBeVisible();
    await stableRow.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toContainText("0-responsive-overwrite.txt");
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the overwrite confirmation at 375px cancels without replacing, replaces on confirm, and stays scroll-free in both themes", async ({
    page,
    context,
  }) => {
    await openPhotos(page, context);

    const row = page.locator("li.list-row", {
      hasText: "0-responsive-overwrite.txt",
    });
    await expect(row).toBeVisible();

    // Self-healing baseline: the object's content is unknown on a retry
    // (the replace step below mutates it), so first restore the seeded
    // "v1" state. The name exists in every state, so uploading "v1"
    // always opens the confirmation; Replace keeps the row listed.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "0-responsive-overwrite.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("v1"),
    });
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("0-responsive-overwrite.txt");
    await expect(dialog).toContainText("already exists");
    await dialog.getByRole("button", { name: "Replace" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Uploaded 0-responsive-overwrite.txt"),
    ).toBeVisible();

    // The object exists: uploading the same name is refused until the
    // user confirms (US4 sc.3).
    await fileInput.setInputFiles({
      name: "0-responsive-overwrite.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("v1"),
    });
    await expect(dialog).toContainText("0-responsive-overwrite.txt");
    await expect(dialog).toContainText("already exists");
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const replace = dialog.getByRole("button", { name: "Replace" });
    await expect(cancel).toBeVisible();
    await expect(replace).toBeVisible();

    // FR-004: cancel and replace carry octicons with unchanged names.
    await expect(cancel.locator("svg")).toBeVisible();
    await expect(replace.locator("svg")).toBeVisible();

    // Cancel keeps the stored object: the name is still listed.
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Confirming replaces the object: success feedback.
    await fileInput.setInputFiles({
      name: "0-responsive-overwrite.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("a longer replacement version"),
    });
    await expect(dialog).toContainText("already exists");
    await replace.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText("Uploaded 0-responsive-overwrite.txt"),
    ).toBeVisible();

    // SC-002: the confirmation is also open at 375px in the dark theme
    // with no overflow. The object now holds the replacement, so the same
    // name still triggers the confirmation; Cancel leaves it in place.
    await page.emulateMedia({ colorScheme: "dark" });
    await fileInput.setInputFiles({
      name: "0-responsive-overwrite.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("a longer replacement version"),
    });
    await expect(dialog).toContainText("already exists");
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the remove confirmation at 375px cancels without removing, removes on confirm, and stays scroll-free in both themes", async ({
    page,
    context,
    browser,
  }) => {
    await startAdmin(page, context);

    // Self-seeded target: register a dedicated user for this attempt via
    // the admin invite API + the register page (the same path admin.spec
    // uses to claim invites). The name is unique per attempt, so a retry
    // never finds the previous attempt's user already removed, and the
    // two repetitions of --repeat-each never collide on one target. The
    // seeded users (alice, admin, rosa, gina, ...) stay untouched.
    const username = `rosa-${Date.now()}`;
    const created = await page.request.post("/api/admin/invites", {
      data: {
        username,
        bucket: "jivedrive-prod",
        prefix: `users/${username}/`,
      },
    });
    expect(created.status()).toBe(201);
    const inviteLink = ((await created.json()) as { link: string }).link;
    const invitee = await browser.newContext();
    const inviteePage = await invitee.newPage();
    await enableVirtualAuthenticator(invitee, inviteePage);
    await inviteePage.goto(inviteLink);
    await inviteePage.getByRole("button", { name: "Create passkey" }).click();
    await expect(inviteePage).toHaveURL(/\/files/);
    await invitee.close();
    // Reload the users table so the freshly registered user appears.
    await page.reload();

    const row = page.getByRole("table", { name: "Users" }).locator("tbody tr", {
      has: page.getByRole("cell").getByText(username, { exact: true }),
    });
    await expect(row).toBeVisible();

    // US4 sc.4: the confirmation dialog opens with usable Cancel/Remove.
    await row.getByRole("button", { name: "Remove" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(username);
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const remove = dialog.getByRole("button", { name: "Remove" });
    await expect(cancel).toBeVisible();
    await expect(remove).toBeVisible();

    // FR-004: cancel and remove carry octicons with unchanged names.
    await expect(cancel.locator("svg")).toBeVisible();
    await expect(remove.locator("svg")).toBeVisible();

    // Cancel closes the dialog without removing: the row stays.
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Confirming removes: explicit feedback and the row disappears.
    await row.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toContainText(username);
    await remove.click();
    await expect(
      page.getByText(new RegExp(`Removed user "${username}"`)),
    ).toBeVisible();
    await expect(row).toHaveCount(0);

    // SC-002: the confirmation is also open at 375px in the dark theme
    // with no overflow. gina is a stable seeded user no spec removes;
    // Cancel leaves her in place.
    await page.emulateMedia({ colorScheme: "dark" });
    const stableRow = page
      .getByRole("table", { name: "Users" })
      .locator("tbody tr", {
        has: page.getByRole("cell").getByText("gina", { exact: true }),
      });
    await expect(stableRow).toBeVisible();
    await stableRow.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toContainText("gina");
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the sign-in page is centred with every control reachable at 375, 768 and 1280", async ({
    page,
  }) => {
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const card = page.getByRole("region", { name: "Sign in" });
      await expect(card).toBeVisible();

      // US4 sc.5: the card is centred horizontally (measured against the
      // content width so a classic vertical scrollbar cannot skew it).
      const metrics = await card.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          centre: box.left + box.width / 2,
          viewport: document.documentElement.clientWidth,
        };
      });
      expect(
        Math.abs(metrics.centre - metrics.viewport / 2),
        `card not centred at ${viewport.width}px`,
      ).toBeLessThan(2);

      // Every control is reachable: the token-gated sign-in page (US1,
      // FR-001/FR-002) offers a single path — the primary username-less
      // passkey button. Registration happens via a full invite link on
      // /register, so there is no in-page register link, no username input
      // and no "First time?" fallback form. The ceremony is not triggered
      // here: this context has no credential.
      await expect(
        page.getByRole("button", { name: "Sign in with passkey" }),
      ).toBeVisible();
      await expect(page.getByLabel("Username")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "First time? Use your username" }),
      ).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }
  });

  test("the register page with an invite token shows the invite details at 375, 768 and 1280", async ({
    page,
  }) => {
    // invite-vera is seeded in e2eServer as a dedicated pending invite for
    // this sweep (auth.spec claims invite-carol, so vera stays pending:
    // the sweep never clicks Create passkey).
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/register?token=invite-vera");

      // US4 sc.6: the invite details render - username prefilled, bucket
      // and prefix badges - plus the Create passkey button, all usable
      // with no horizontal scroll.
      await expect(page.getByLabel("Your username")).toHaveValue("vera");
      await expect(page.getByText("Bucket: jivedrive-prod")).toBeVisible();
      await expect(page.getByText("Prefix: users/vera/")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Create passkey" }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});
