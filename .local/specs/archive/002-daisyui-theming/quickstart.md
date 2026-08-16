# Quickstart: daisyUI Theming & Conversion

Key end-to-end integration scenarios, phrased for later validation
(`scripts/verify-*.sh` and the Playwright suite are the executable forms).

## Scenario 1 — Light mode renders corporate

1. Start the app (dev or e2e server). Emulate a light color scheme
   (`page.emulateMedia({ colorScheme: "light" })`).
2. Visit `/` (sign in) → the page background is the corporate base color;
   the sign-in card renders with daisyUI inputs and a primary button.
3. Sign in → `/files` shows the navbar, sidebar, breadcrumbs, and the file
   table all themed corporate; the table has no horizontal overflow at
   375px, tablet, and desktop widths.
4. `/admin` (as admin) renders invites/users tables with status badges,
   themed corporate, no horizontal overflow.

**Expected**: every screen renders in the corporate theme; all flows work.

## Scenario 2 — Dark mode renders business

1. Emulate a dark color scheme (`colorScheme: "dark"`).
2. Repeat Scenario 1 across `/`, `/files`, `/admin`.
3. Verify a visible sign-in error alert (`alert-error`) and an upload
   success alert (`alert-success`) in dark mode are readable (theme
   tokens, not hard-coded colors).

**Expected**: every screen renders in the business theme; contrast and
status colors are theme-derived.

## Scenario 3 — Live preference flip, no reload

1. Emulate light; land on `/files` with a listing visible.
2. Flip to dark via `emulateMedia` (no page reload, no navigation).
3. Assert the page background changes to the business base and the listing
   still shows the same items.
4. Flip back to light; background returns to corporate; state preserved.

**Expected**: theme changes instantly, session and UI state intact.

## Scenario 4 — Mobile widths in both themes

1. In light and dark, set viewports 375×667, 768×1024, and 1280×800 on
   `/files` and `/admin`.
2. Open the share dialog and the delete confirmation on 375px.

**Expected**: `document.documentElement.scrollWidth <= clientWidth` in every
combination (constitution VI); dialogs fully usable at 375px.

## Scenario 5 — Bundle ships exactly two themes

1. `bun run --cwd frontend build`.
2. Inspect `frontend/dist/assets/*.css`: exactly one `:root` theme block
   (corporate) and one `@media (prefers-color-scheme: dark)` block
   (business); a distinctive token of an unconfigured theme (e.g. `lofi`
   base color) is absent.

**Expected**: SC-007 holds; no third-theme data in the bundle.

## Scenario 6 — Full regression

1. `bun test` (or the repo's vitest command) — unit suite green (untouched
   modules).
2. Playwright suite (`bunx playwright test` from `e2e/`): auth, browse,
   upload, share, delete, admin, and the new theme spec all pass.

**Expected**: every existing behavior unchanged after the conversion.
