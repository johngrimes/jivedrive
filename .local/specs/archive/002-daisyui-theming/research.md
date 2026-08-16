# Research: daisyUI Theming & Conversion

One decision/rationale/alternatives entry per resolved technical question.

## R1. Component library: daisyUI 5 + Tailwind CSS 4

- **Decision**: Add `tailwindcss@^4`, `@tailwindcss/vite@^4`, and
  `daisyui@^5` as frontend devDependencies; register the Vite plugin in
  `frontend/vite.config.ts`; theme and components configured from
  `frontend/src/index.css` via `@import "tailwindcss"` + `@plugin "daisyui"`.
- **Rationale**: daisyUI 5 is the current major and is built for Tailwind 4
  (CSS-first, no `tailwind.config.js`, no PostCSS wiring — the Vite plugin
  handles it). The corporate and business themes are built-in. The user
  explicitly requested daisyUI.
- **Alternatives considered**:
  - daisyUI 4 + Tailwind 3: previous major; requires `tailwind.config.js`,
    `postcss.config.js`, and `content` globs; older theme system.
  - Hand-rolled CSS (status quo): rejected by the request.
  - MUI / Mantine / Ant: not requested, heavier runtime JS, theme tokens are
    not the corporate/business palettes.

## R2. Theme switching: `--prefersdark` plugin flag

- **Decision**: Configure
  `@plugin "daisyui" { themes: corporate --default, business --prefersdark; }`.
  `--default` makes corporate the light default; `--prefersdark` makes
  business the theme under `prefers-color-scheme: dark`. Verified against
  the official daisyUI 5 themes/config docs (2026-08-16).
- **Rationale**: exactly the requested behavior — automatic, live (CSS media
  query, no reload), no manual control, no persisted preference. Only two
  themes compile (SC-007). daisyUI 5 ships this as the documented mechanism.
- **Alternatives considered**:
  - `data-theme` attribute + `theme-change` JS controller: requires JS, a
    persisted override, and extra code — the user chose system-only.
  - Hand-written `html { theme: corporate } @media (prefers-color-scheme:
    dark) { theme: business }`: equivalent, but the `@plugin` config is the
    canonical, documented form with less custom CSS.
  - Enabling all 35 themes: rejected — ships unused theme data (FR-009).

## R3. Touch targets ≥ 44px: global `--size-field`

- **Decision**: Set `:root { --size-field: 0.275rem; }` in `index.css`.
  daisyUI 5.7.17 sizes fields (button, input, select, textarea) from
  `--size: calc(var(--size-field, .25rem) * 10)` — so the value is
  `0.275rem` (×10 = 2.75rem = 44px), matching the current stylesheet's
  stated minimum. Do not use `btn-sm`/`btn-xs` on primary touch controls —
  they override `--size` below 44px.
- **Rationale**: one variable enforces the rule everywhere (constitution VI)
  instead of sprinkling `min-h-11` per component.
- **Alternatives considered**:
  - `min-h-11` per component: easy to miss in future work, verbose.
  - Keeping 40px default: violates the existing 44px rule stated in the
    current CSS.

## R4. Breakpoints: Tailwind default scale

- **Decision**: Use Tailwind defaults — `sm` 640, `md` 768, `lg` 1024.
  Files sidebar appears at `md` (unchanged, currently 768). Admin sidebar
  moves from the custom 900px to `lg` (1024).
- **Rationale**: standard utility grid; the 900px admin value was chosen
  because six columns don't fit beside a 220px sidebar at 768 — at 1024 they
  fit comfortably. IA (sidebar-on-desktop) is unchanged; only the exact
  threshold moves. e2e admin/browse viewports are ≥ 1024 and unaffected.
- **Alternatives considered**:
  - Arbitrary `min-[900px]:` variants: preserves 900 exactly but imports a
    one-off value into every admin layout line for no behavioral benefit.
  - Preserving the 899px collapse threshold: same arbitrary-value cost.

## R5. Modal pattern: conditional divs + daisyUI modal classes

- **Decision**: Keep the existing conditional-render overlay pattern; apply
  `modal modal-open` to the overlay, `modal-box` to the panel, and a
  `modal-backdrop` button that closes via the existing onClose handler.
  Preserve `role="alertdialog"` and the accessible label on the overlay.
- **Rationale**: zero change to open/close state logic or focus behavior;
  daisyUI 5 supports the div-based modal with `modal-open`. The e2e suite
  queries `getByRole("alertdialog")` — preserved.
- **Alternatives considered**:
  - Native `<dialog>` element: daisyUI's documented markup, but requires
    reworking open/close logic (showModal/close, backdrop handling) for no
    user-visible gain here.

## R6. e2e theme assertions: computed background vs compiled tokens

- **Decision**: In `e2e/theme.spec.ts`, use `page.emulateMedia({ colorScheme:
  "light" | "dark" })`, then assert
  `getComputedStyle(document.documentElement).backgroundColor` equals the
  corporate base (light) / business base (dark) token values, read from the
  compiled CSS during implementation and hardcoded in the test with a
  comment. Assert the live flip re-renders without reload (background
  changes while the same page stays open).
- **Rationale**: with `--prefersdark`, daisyUI never sets a `data-theme`
  attribute — the theme lives in the CSS media query. The computed
  background color is the observable truth of the applied theme.
- **Alternatives considered**:
  - `data-theme` attribute assertion: fails — the attribute is only set by
    the JS theme controller we deliberately don't use.
  - `window.matchMedia("(prefers-color-scheme: dark)")`: proves the
    emulation, not the applied theme.

## R7. e2e selector migration: role/label-based, no legacy hooks

- **Decision**: Replace class-based selectors with role/label/text queries:
  `.app-session-user` → `page.getByText(\`Signed in as ${username}\`)`;
  `.app-session` sign-out scoping → `getByRole("button", { name: "Sign out" })`;
  `.invites-table` / `.users-table` → `getByRole("table", { name: "Invites" })`
  / `{ name: "Users" }` (tables gain `aria-label`s). All other e2e selectors
  are already role/label/text-based and survive.
- **Rationale**: clean cutover — no legacy class names kept as shims; the
  selectors become markup-agnostic so future restyles don't break them.
- **Alternatives considered**:
  - Keeping `.app-session-user` etc. as class hooks on converted components:
    rejected — preserves a dead vocabulary (constitution: no deprecated
    paths).
  - `data-testid` attributes: noisier than role queries; existing suite
    favors roles.
