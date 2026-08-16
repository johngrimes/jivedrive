import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectSignedInAs } from "./helpers";

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
