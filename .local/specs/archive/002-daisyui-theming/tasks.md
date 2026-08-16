# Tasks: daisyUI Theming & Conversion

**Input**: Design documents in `.local/specs/002-daisyui-theming/`
**Prerequisites**: plan.md (required), spec.md (required for user stories); research.md (present); data-model.md and contracts/ intentionally absent (no data, no external interfaces).

**Tests**: Test-driven development is mandatory. New behaviour (theme
switching) is covered by `e2e/theme.spec.ts`, written first and confirmed
failing before the theming implementation. Existing flows are regression
contracts: their selectors are migrated to daisyUI-agnostic role/label/text
queries before each story's component conversion, and the suite stays green
through every checkpoint. Fail-first applies to new behaviour; refactor
selectors are written before the markup they validate.

**Organisation**: Tasks are grouped by user story (spec order) so each story
can be implemented and tested independently.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks).
- **[Story]**: US1 theme foundation, US2 shell/auth, US3 file browser, US4 admin.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Toolchain wiring so the frontend builds with Tailwind 4 + daisyUI.

- [x] T001 Add `tailwindcss@^4`, `@tailwindcss/vite@^4`, `daisyui@^5` to
  `frontend/package.json` devDependencies and install (updates `bun.lock`).
- [x] T002 Register the `tailwindcss()` Vite plugin in `frontend/vite.config.ts`.

---

## Phase 2: User Story 1 - System-following theming (Priority: P1) 🎯 MVP

**Goal**: corporate in light mode, business in dark mode, switching live with
the system preference — CSS-only, no override (spec FR-002..FR-004, SC-001/SC-002).

**Independent Test**: `e2e/theme.spec.ts` alone proves the story (light,
dark, live flip, no-preference default).

### Tests for User Story 1 ⚠️ write first, confirm failing before implementing

- [x] T003 [US1] Write `e2e/theme.spec.ts`: emulate light → assert
  `getComputedStyle(document.documentElement).backgroundColor` equals the
  corporate base token; emulate dark → business base token; flip mid-session
  on `/files` → background changes with no reload; no-preference → corporate.
  Tokens hardcoded from the compiled CSS (documented in a comment). Run and
  confirm it FAILS before theming exists (background is not the theme token).

### Implementation for User Story 1

- [x] T004 [US1] Rewrite `frontend/src/index.css` head: `@import
  "tailwindcss"`; `@plugin "daisyui" { themes: corporate --default, business
  --prefersdark; }`; `:root { --size-field: 0.275rem; }` (44px touch targets
  via daisyUI's ×10 --size calc,
  constitution VI); `html { color-scheme: light; }` with a
  `prefers-color-scheme: dark` override. Legacy component rules stay in the
  file temporarily — they are deleted per-story.

**Checkpoint**: `theme.spec.ts` green; app renders with legacy styling inside
the correct theme; build passes.

---

## Phase 3: User Story 2 - Shell and auth screens (Priority: P1)

**Goal**: navbar header with sign-in state, sign-in and register cards built
from daisyUI primitives (spec FR-001, FR-007, FR-008; SC-003/SC-004/SC-006).

**Independent Test**: `auth.spec.ts` + updated `helpers.ts` prove the shell
and auth flows on the converted UI.

### Tests for User Story 2 ⚠️ written before conversion, green before and after

- [x] T005 [P] [US2] Update `e2e/helpers.ts` and `e2e/auth.spec.ts`:
  `.app-session-user` → `getByText(\`Signed in as ${username}\`)`;
  `.app-session` sign-out scoping → `getByRole("button", { name: "Sign out" })`;
  sign-in state assertion → header link/role queries. Run: suite green
  against current markup (refactor, no behaviour change).

### Implementation for User Story 2

- [x] T006 [P] [US2] Convert `frontend/src/components/AppShell.tsx` to a
  daisyUI `navbar` (brand link, session state, sign-out `btn` — default size,
  no `btn-sm`).
- [x] T007 [P] [US2] Convert `frontend/src/pages/SignIn.tsx`: `card` with
  `input` (label "Username"), primary `btn` "Continue with passkey",
  `alert alert-error`/`alert-info` for error/status; keep `aria-label="Sign in"`.
- [x] T008 [P] [US2] Convert `frontend/src/pages/Register.tsx`: same card
  pattern with read-only invite fields; keep `aria-label="Register with invite"`.
- [x] T009 [US2] Delete the shell/auth legacy rules (`.app-shell`,
  `.app-header`, `.app-logo`, `.app-session*`, `.auth-card`, `.auth-title`,
  `.auth-sub`, `.field-*`, `.text-input`, `.button*`, `.divider`,
  `.annotation`, `.tag*`, `.status`, `.error`, `.success`) from
  `frontend/src/index.css`.

**Checkpoint**: `auth.spec.ts` + `theme.spec.ts` green; shell and auth
screens fully themed; no legacy shell/auth classes remain in JSX.

---

## Phase 4: User Story 3 - File browser (Priority: P1)

**Goal**: breadcrumbs, table, upload with progress, share/delete/overwrite
dialogs on daisyUI primitives (spec FR-001, FR-005..FR-008; SC-003/SC-004/SC-006).

**Independent Test**: `browse/upload/share/delete` specs prove the converted
browser, including 375px no-overflow in both themes.

### Tests for User Story 3 ⚠️ written before conversion, green before and after

- [x] T010 [P] [US3] Adjust `e2e/browse.spec.ts`, `e2e/upload.spec.ts`,
  `e2e/share.spec.ts`, `e2e/delete.spec.ts` where they rely on structural
  selectors that change (`tbody tr` stays, but re-verify row/action queries);
  extend `e2e/theme.spec.ts` with a dark-mode 375px no-horizontal-overflow
  sweep on `/files`.

### Implementation for User Story 3

- [x] T011 [P] [US3] Convert `frontend/src/components/FileListing.tsx`:
  `breadcrumbs`, `table` (headers Name/Size/Modified/Actions), folder rows as
  links, file rows with `link`-class Download/Share/Delete actions, empty
  state, `skeleton` rows.
- [x] T012 [P] [US3] Convert `frontend/src/components/UploadControl.tsx`:
  dashed dropzone (Tailwind utilities), `progress progress-primary`, status
  `alert`s, overwrite-confirmation modal trigger; keep the hidden
  `input[type="file"]` and progress/status text.
- [x] T013 [P] [US3] Convert `frontend/src/components/ShareModal.tsx`:
  `modal modal-open` + `modal-box` + `modal-backdrop`, readonly share-link
  `input`, copy `btn`, expiry text; preserve `role="alertdialog"` and label.
- [x] T014 [P] [US3] Convert `frontend/src/components/DeleteDialog.tsx`:
  `modal` pattern with Cancel/Delete `btn`s; preserve `role="alertdialog"`.
- [x] T015 [P] [US3] Convert `frontend/src/pages/Files.tsx`: layout with
  sidebar (`md+`), page title, toolbar (upload control + item count), Load
  more `btn`, retry handling.
- [x] T016 [US3] Delete the file-browser legacy rules (`.files-layout`,
  `.files-sidebar*`, `.files-main`, `.files-title`, `.breadcrumbs*`,
  `.files-toolbar`, `.files-count`, `.file-table*`, `.file-*`,
  `.folder-link`, `.load-more`, `.empty-state*`, `.file-skeleton`,
  `.skeleton-*`, `.upload-*`, `.modal-overlay`, `.confirm-dialog*`,
  `.share-*`) from `frontend/src/index.css`.

**Checkpoint**: `browse/upload/share/delete` + `theme` specs green; file
browser fully themed in both modes; no legacy file-browser classes remain.

---

## Phase 5: User Story 4 - Admin user management (Priority: P2)

**Goal**: invite card, status badges, users/invites tables, removal
confirmation on daisyUI primitives (spec FR-001, FR-005..FR-008; SC-003/SC-004).

**Independent Test**: `admin.spec.ts` proves the converted admin surface.

### Tests for User Story 4 ⚠️ written before conversion, green before and after

- [x] T017 [P] [US4] Update `e2e/admin.spec.ts`: `.invites-table` /
  `.users-table` → `getByRole("table", { name: "Invites" })` /
  `{ name: "Users" }`; keep `input[readonly]` for the generated link; add a
  dark-mode no-overflow sweep on `/admin` to `e2e/theme.spec.ts`.

### Implementation for User Story 4

- [x] T018 [P] [US4] Convert `frontend/src/pages/AdminUsers.tsx`: invite
  creation `card` (username `input`, role `select`, expiry `select`, admin
  `checkbox` in a ≥44px label row), generated-link card with readonly input +
  copy `btn`, invites table with status `badge`s (pending/claimed/expired),
  users table with Remove actions, removal-confirmation `modal`; add
  `aria-label="Invites"` / `aria-label="Users"` to the tables.
- [x] T019 [US4] Delete the admin legacy rules (`.admin-*`, `.invite-*`,
  `.file-action-danger`, `.empty-state-text`, `.admin-checkbox*`) from
  `frontend/src/index.css`.

**Checkpoint**: `admin.spec.ts` + full e2e suite green; admin fully themed.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: prove the cutover is complete and the suite is green.

- [x] T020 [P] Sweep `frontend/src` (grep) for legacy class names and inline
  hex/color styles; remove any leftovers; confirm `frontend/src/index.css`
  custom CSS is minimal (< 100 lines beyond the theme/config block).
- [x] T021 Build `frontend` (`bun run --cwd frontend build`) and inspect
  `frontend/dist/assets/*.css`: exactly one `:root` theme block (corporate)
  and one `@media (prefers-color-scheme: dark)` block (business); a
  distinctive token of an unconfigured theme is absent (SC-007, FR-009).
- [x] T022 Run the full suite: `bun run test` (backend + frontend unit) and
  `bun run test:e2e` — all green (SC-003).
- [x] T023 Run `quickstart.md` scenarios 1-4 and 6 against the built app;
  record results (SC-001..SC-004, SC-006).

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies; must land first.
- **US1 (Phase 2)**: depends on Setup; blocks all other stories (theming must
  exist before converted screens can be verified in both modes).
- **US2/US3/US4 (Phases 3-5)**: depend on US1; independent of each other
  (different files), runnable in priority order (P1: US2, US3 → P2: US4) or
  in parallel.
- **Polish (Phase 6)**: depends on all stories complete.

Within each story: tests/selector migrations written first, then component
conversions, then the story's legacy-CSS deletion. `[P]` tasks on different
files may run together; T009/T016/T019 (index.css deletions) run after their
story's conversions and are not parallel with them.

## Implementation Strategy

MVP first: Setup → US1 theming (failing `theme.spec.ts` → CSS wiring), then
US2 shell/auth, US3 file browser, US4 admin, each leaving the suite green,
then Polish (leftover sweep, bundle check, full suite, quickstart).
