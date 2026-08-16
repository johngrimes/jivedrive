import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import {
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

test.describe("User Story 1 - responsive navigation: drawer + permanent sidebar", () => {
  test("a signed-in admin at 375px opens the drawer, navigates to /admin, and the drawer closes", async ({
    page,
    context,
  }) => {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "admin");

    // Below lg the navigation lives behind a hamburger, not a sidebar.
    const hamburger = page.getByRole("button", { name: "Open menu" });
    await expect(hamburger).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeHidden();

    // Opening the drawer reveals the same navigation as the desktop
    // sidebar: Files, Manage users (admin), and the bucket/space info.
    await hamburger.click();
    await expect(page.locator(".drawer-toggle")).toBeChecked();
    await expect(page.getByRole("link", { name: "Files" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeVisible();
    await expect(page.getByText("Bucket: jivedrive-prod")).toBeVisible();
    await expect(page.getByText("Space: users/admin/")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Menu items keep the 44px touch target (FR-008).
    const manageUsers = page.getByRole("link", { name: "Manage users (admin)" });
    const itemHeight = await manageUsers.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(itemHeight).toBeGreaterThanOrEqual(44);

    // Tapping Manage users navigates to /admin and the drawer closes
    // instead of covering the destination screen (FR-011, US1 sc.1).
    await manageUsers.click();
    await expect(page).toHaveURL(/\/admin/);
    await expect(
      page.getByRole("heading", { name: "User management" }),
    ).toBeVisible();
    await expect(page.locator(".drawer-toggle")).not.toBeChecked();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("a signed-in non-admin at 375px never sees the Manage users entry in the drawer", async ({
    page,
    context,
  }) => {
    await context.addCookies([BROWSE_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "alice");

    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("link", { name: "Files" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Manage users/ }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("a signed-in user gets a hamburger below lg and a permanent sidebar at 1280px", async ({
    page,
    context,
  }) => {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.goto("/files");
    await expectSignedInAs(page, "admin");

    // Below lg (768px is md): the sidebar is a drawer behind the hamburger.
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeHidden();
    await expectNoHorizontalOverflow(page);

    // At lg and up the drawer is permanently open as the sidebar and the
    // hamburger is absent (FR-001, US1 sc.3).
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("link", { name: "Files" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeVisible();
    await expect(page.getByText("Bucket: jivedrive-prod")).toBeVisible();
    await expect(page.getByText("Space: users/admin/")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

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
    // ellipsizes inside the span instead of pushing the page wide (FR-003,
    // US1 sc.4).
    const signInState = page.getByText(`Signed in as ${LONG_USERNAME}`, {
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

  test("the open drawer at 375px in the dark theme causes no horizontal overflow", async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "admin");

    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("the hamburger and drawer links are keyboard-focusable with visible focus", async ({
    page,
    context,
  }) => {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "admin");

    // The hamburger is the first tab stop below lg.
    const hamburger = page.getByRole("button", { name: "Open menu" });
    await expect(hamburger).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(hamburger).toBeFocused();
    expect(
      await hamburger.evaluate((el) => el.matches(":focus-visible")),
    ).toBe(true);

    // Enter opens the drawer.
    await hamburger.press("Enter");
    await expect(page.locator(".drawer-toggle")).toBeChecked();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeVisible();

    // The drawer links are focusable: tab forward until Manage users
    // receives focus (the drawer side is last in the DOM/tab order).
    const manageUsers = page.getByRole("link", { name: "Manage users (admin)" });
    for (let i = 0; i < 30; i += 1) {
      if (await manageUsers.evaluate((el) => el === document.activeElement)) {
        break;
      }
      await page.keyboard.press("Tab");
    }
    await expect(manageUsers).toBeFocused();
    expect(
      await manageUsers.evaluate((el) => el.matches(":focus-visible")),
    ).toBe(true);

    // Activating the focused link navigates and closes the drawer (FR-011).
    await manageUsers.press("Enter");
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.locator(".drawer-toggle")).not.toBeChecked();
  });

  test("clicking the dimmed overlay closes the drawer at 375px", async ({
    page,
    context,
  }) => {
    await context.addCookies([ADMIN_SESSION_COOKIE]);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/files");
    await expectSignedInAs(page, "admin");

    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.locator(".drawer-toggle")).toBeChecked();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeVisible();

    // Click the dimmed area to the right of the w-72 (288px) panel.
    await page.locator(".drawer-overlay").click({
      position: { x: 360, y: 300 },
    });
    await expect(page.locator(".drawer-toggle")).not.toBeChecked();
    await expect(
      page.getByRole("link", { name: "Manage users (admin)" }),
    ).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("User Story 2 - file browser rendered for mobile, with octicons", () => {
  /** The seeded root file whose size renders as "812 KB" (see e2eServer.ts). */
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

  /**
   * The stacked metadata line renders as `formatSize(size) · formatDate(iso)`
   * (frontend/src/lib/format.ts): e.g. "812 KB · 2026-08-10 22:00". The date
   * is rendered in the browser's local timezone, so only its shape is pinned.
   */
  const METADATA_RE = /^812 KB · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

  test("at 375px a file row stacks size and modified under the name and shows icon-only action buttons", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const row = page.locator("tbody tr", { hasText: FILE_ROW_TEXT });
    await expect(row).toBeVisible();

    // FR-005 / US2 sc.1: below sm the size and modified date render as a
    // secondary line under the name instead of vanishing.
    const metadata = row.getByText(METADATA_RE);
    await expect(metadata).toBeVisible();
    await expect(metadata).toHaveText(METADATA_RE);

    // FR-007 / US2 sc.1: the actions are buttons with accessible names
    // identical to today's text labels, icon-only below sm (the label span
    // is not visible, the icon svg is).
    for (const action of ["Download", "Share", "Delete"]) {
      const button = row.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toBeVisible();
      await expect(
        button.getByText(action, { exact: true }),
      ).toBeHidden();
    }

    // Octicons replaced the emoji (FR-004): no 📁/📄 anywhere in the rows.
    await expect(page.locator("tbody")).not.toContainText(["📁", "📄"]);
    await expectNoHorizontalOverflow(page);
  });

  test("file action buttons are at least 44px tall at 375px", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const row = page.locator("tbody tr", { hasText: FILE_ROW_TEXT });
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
    // did: the browser fetches the presigned URL and gets the bytes.
    const downloadPromise = page.waitForEvent("download");
    await page
      .locator("tr", { hasText: "notes.txt" })
      .getByRole("button", { name: "Download" })
      .click();
    const download = await downloadPromise;
    const content = await readStream(await download.createReadStream());
    expect(download.suggestedFilename()).toBe("notes.txt");
    expect(download.url()).toContain("localhost:5299");
    expect(download.url()).toContain("X-Amz-Signature");
    expect(content.toString()).toBe("hello from notes");
  });

  test("at 768px size and modified render in their own columns and actions show icon + text", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize({ width: 768, height: 1024 });
    const row = page.locator("tbody tr", { hasText: FILE_ROW_TEXT });
    await expect(row).toBeVisible();

    // US2 sc.2: the Size and Modified columns return at sm+ ...
    const sizeCell = row.locator("td").nth(1);
    await expect(sizeCell).toBeVisible();
    await expect(sizeCell).toHaveText("812 KB");
    const modifiedCell = row.locator("td").nth(2);
    await expect(modifiedCell).toBeVisible();
    await expect(modifiedCell).toHaveText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    // ... and the stacked metadata line is hidden again at sm+ (one DOM
    // tree, CSS-only relocation per research R3).
    await expect(row.getByText(/^812 KB · /)).toBeHidden();

    // US2 sc.2 / FR-007: actions show the icon AND the visible text label.
    const download = row.getByRole("button", { name: "Download" });
    await expect(download).toBeVisible();
    await expect(download.locator("svg")).toBeVisible();
    await expect(
      download.getByText("Download", { exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a folder row shows a folder octicon, navigates on tap, and never shows file actions", async ({
    page,
    context,
  }) => {
    await startSignedIn(page, context);
    await page.setViewportSize(MOBILE_VIEWPORT);

    // US2 sc.3: folders stay links (they navigate), carry the folder
    // octicon, and never expose the file actions.
    const folderRow = page.locator("tbody tr", { hasText: "docs" });
    await expect(
      folderRow.getByRole("link", { name: "docs" }),
    ).toBeVisible();
    await expect(folderRow.locator("svg")).toBeVisible();
    await expect(folderRow.getByRole("button")).toHaveCount(0);
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
    // Upload into docs/ (not the root) so the root item counts asserted by
    // browse.spec stay stable. The name is unique per attempt so a Playwright
    // retry (CI sets retries=2) never hits the overwrite confirmation.
    await page.getByRole("link", { name: /docs/ }).click();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toContainText("docs");
    const fileName = `mobile upload check ${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from("mobile upload check"),
    });
    await expect(page.getByText(`Uploaded ${fileName}`)).toBeVisible();
    await expect(
      page.locator("tbody tr", { hasText: fileName }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("long file names wrap at 375px with no horizontal scroll", async ({
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
    const specialRow = page.locator("tbody tr", {
      hasText: "my file #1?.txt",
    });
    await expect(specialRow).toBeVisible();
    await expect(
      specialRow.getByRole("button", { name: "Download" }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A genuinely long name wraps onto multiple lines instead of widening
    // the page: upload one at 375px and check its row is taller than a
    // normal single-line row (unique name per attempt, retry-safe).
    const longName = `a-very-long-file-name-that-wraps-onto-multiple-lines-when-rendered-on-a-375px-phone-screen-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({
      name: longName,
      mimeType: "text/plain",
      buffer: Buffer.from("long name"),
    });
    await expect(page.getByText(`Uploaded ${longName}`)).toBeVisible();
    const longRow = page.locator("tbody tr", { hasText: longName });
    await expect(longRow).toBeVisible();
    const normalRow = page.locator("tbody tr", { hasText: "notes.txt" });
    const longHeight = await longRow.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    const normalHeight = await normalRow.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(longHeight).toBeGreaterThan(normalHeight);
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
