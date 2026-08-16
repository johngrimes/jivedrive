import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

/**
 * Window marker proving the live-flip test never reloads or navigates: a
 * reload would wipe it. Declared on the real Window global (no cast).
 */
declare global {
  interface Window {
    __themeSpecMarker?: string;
  }
}

/**
 * Applied-theme tokens, hardcoded from the compiled production CSS
 * (`frontend/dist/assets/*.css` after `bun run --cwd frontend build`,
 * verified 2026-08-16; e.g. `index-jpen3r_h.css`): the `:root` block holds
 * the corporate theme (`--color-base-100: oklch(100% 0 0)`) and the
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ... } }`
 * block holds the business theme (`--color-base-100: oklch(24.353% 0 0)`) —
 * daisyUI 5.7.17 `themes: corporate --default, business --prefersdark`,
 * compiled verbatim. The values are each theme's `--color-base-100`.
 *
 * The root element's `--color-base-100` custom property is the authoritative
 * applied-theme signal: the engine returns custom properties verbatim,
 * whereas it re-serializes computed `backgroundColor` through the color
 * pipeline (e.g. `oklch(100% 0 0)` → `oklch(1 0 0)`), making exact string
 * equality on the background fragile.
 */
const CORPORATE_BASE_100 = "oklch(100% 0 0)";
const BUSINESS_BASE_100 = "oklch(24.353% 0 0)";

/**
 * The pre-seeded e2e session cookie (same pattern as e2e/browse.spec.ts).
 * `/files` requires a session; `/` does not.
 */
const SESSION_COOKIE = {
  name: "jivedrive_session",
  value: "browse-session",
  url: "http://localhost:5173",
};

/** The root element's applied base-100 token (verbatim custom property). */
async function rootBase100(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--color-base-100")
      .trim(),
  );
}

/** The root element's computed background color. */
async function rootBackground(page: Page): Promise<string> {
  return page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
}

/**
 * Assert the applied theme on the root element (document.documentElement):
 * the exact base-100 token plus a real, non-transparent computed background.
 * The background is only asserted qualitatively because of Chromium's oklch
 * re-serialization (see the token comment above).
 */
async function expectAppliedTheme(page: Page, base100: string): Promise<void> {
  await expect.poll(() => rootBase100(page)).toBe(base100);
  const background = await rootBackground(page);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

test.describe("system-following theming (US1)", () => {
  test.describe("light color scheme → corporate", () => {
    test("applies the corporate theme on the home screen", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/");
      await expectAppliedTheme(page, CORPORATE_BASE_100);
    });

    test("applies the corporate theme on the signed-in files screen", async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/files");
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expectAppliedTheme(page, CORPORATE_BASE_100);
    });
  });

  test.describe("dark color scheme → business", () => {
    test("applies the business theme on the home screen", async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/");
      await expectAppliedTheme(page, BUSINESS_BASE_100);
    });

    test("applies the business theme on the signed-in files screen", async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/files");
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expectAppliedTheme(page, BUSINESS_BASE_100);
    });
  });

  test.describe("live preference flip (SC-002)", () => {
    test("switches corporate → business → corporate on /files with no reload and no lost state", async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/files");
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expectAppliedTheme(page, CORPORATE_BASE_100);

      // Marker proving the page is never reloaded or navigated: a reload
      // would wipe this window property.
      await page.evaluate(() => {
        window.__themeSpecMarker = "alive";
      });

      // Flip light → dark: the CSS media query re-evaluates live.
      await page.emulateMedia({ colorScheme: "dark" });
      await expectAppliedTheme(page, BUSINESS_BASE_100);
      expect(page.url()).toContain("/files");
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__themeSpecMarker))
        .toBe("alive");

      // Flip dark → light: back to corporate, state still intact.
      await page.emulateMedia({ colorScheme: "light" });
      await expectAppliedTheme(page, CORPORATE_BASE_100);
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__themeSpecMarker))
        .toBe("alive");
    });
  });

  test.describe("no system preference (edge case)", () => {
    test("falls back to corporate; dark never appears spuriously", async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: "no-preference" });
      await page.goto("/");
      await expectAppliedTheme(page, CORPORATE_BASE_100);
    });
  });

  test.describe("mobile width in dark theme (SC-004)", () => {
    test("the file browser has no horizontal overflow at 375px in dark mode", async ({
      page,
      context,
    }) => {
      await context.addCookies([SESSION_COOKIE]);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto("/files");
      // The listing rendered inside the business theme: no horizontal
      // scroll at the narrowest supported width (the light-mode sweep
      // lives in browse.spec).
      await expect(page.getByText("archive.zip")).toBeVisible();
      await expectAppliedTheme(page, BUSINESS_BASE_100);
      await expectNoHorizontalOverflow(page);
    });

    test("the admin screen has no horizontal overflow at 375px in dark mode", async ({
      page,
      context,
    }) => {
      // The pre-seeded admin session (same pattern as e2e/admin.spec.ts).
      await context.addCookies([
        {
          name: "jivedrive_session",
          value: "admin-session",
          url: "http://localhost:5173",
        },
      ]);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto("/admin");
      // The user management screen rendered inside the business theme: no
      // horizontal scroll at the narrowest supported width (the light-mode
      // sweep lives in admin.spec).
      await expect(
        page.getByRole("heading", { name: "User management" }),
      ).toBeVisible();
      await expectAppliedTheme(page, BUSINESS_BASE_100);
      await expectNoHorizontalOverflow(page);
    });
  });
});
