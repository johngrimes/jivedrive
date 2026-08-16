# Tasks: Mobile-Responsive UI with Octicons

**Input**: Design documents in `.local/specs/003-mobile-responsive-ui/`
**Prerequisites**: plan.md (required), spec.md (required for user stories); research.md, quickstart.md present; no data model or contracts (none needed).

**Tests**: Test-driven development is mandatory. Every behaviour is covered by a
test task that precedes its implementation task, and those tests must be written
to fail first.

**Organisation**: Tasks are grouped by user story so each story can be
implemented and tested independently.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks).
- **[Story]**: the user story a task belongs to (US1, US2, ...); omitted for Setup, Foundational, and Polish.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the one new dependency.

- [x] T001 Add `@primer/octicons-react@^19.33.0` to `dependencies` in `frontend/package.json` and refresh the lockfile with `bun install` (`bun.lock`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the green baseline before any behaviour changes.

- [x] T002 Run the full existing e2e suite (`bun run --cwd e2e playwright test`) and record it green before any change; any pre-existing failure must be reported, not silently carried.

**Checkpoint**: Foundation ready - user story implementation can begin.

---

## Phase 3: User Story 1 - Responsive navigation (Priority: P1) 🎯 MVP

**Goal**: Drawer + hamburger below `lg`, permanent sidebar at `lg`+, sign-in state visible at every width.

**Independent Test**: Admin at 375px: hamburger → drawer → Manage users → `/admin`, drawer closed; non-admin drawer lacks Manage users; 1280px: permanent sidebar, no hamburger; signed-out: no hamburger; navbar state visible, no overflow.

### Tests for User Story 1 ⚠️ write first, confirm failing before implementing

- [x] T003 [US1] Drawer + navbar tests in `e2e/responsive.spec.ts`: admin opens drawer at 375px, taps Manage users, lands on `/admin`, drawer closed after navigation (FR-001/002/011); non-admin drawer has no Manage users link (FR-002); 1280px shows the permanent sidebar and no hamburger (FR-001); signed-out visitor sees no hamburger (US1 sc.5); sign-in state visible and no horizontal overflow at 375px (FR-003). Confirm failing: no drawer/hamburger exists today.


- [x] T004 [US1] Create `frontend/src/components/Sidebar.tsx`: daisyUI `menu` with Files and Manage users (admin-only) items, active-state prop, bucket/space info block; JSDoc on the export (functional TypeScript, constitution III).
- [x] T005 [US1] Rework `frontend/src/components/AppShell.tsx`: wrap the routed page in a daisyUI `drawer lg:drawer-open`; hamburger button (`ThreeBarsIcon`, accessible label, below `lg`, signed-in only) toggles a controlled checkbox; `useLocation` effect resets it after navigation (FR-011); render `Sidebar` in the drawer side.
- [x] T006 [US1] Remove the page-level `<aside>` blocks and their wrapper classes from `frontend/src/pages/Files.tsx` and `frontend/src/pages/AdminUsers.tsx` (navigation now lives in the shell; pages keep only their content card).
- [x] T007 [US1] Truncate the "Signed in as `<username>`" span in `frontend/src/components/AppShell.tsx` (ellipsis + max-width) so long usernames cannot overflow at 375px (FR-003); add `SignOutIcon` to the sign-out button (FR-004).

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - File browser mobile + octicons (Priority: P1)
**Goal**: Stacked size/modified under the name below `sm`; octicon folder/file icons; row actions as icon+text buttons (`sm`+)/icon-only with accessible names (below `sm`); upload + Home octicons.

**Independent Test**: 375px listing shows stacked metadata and icon-only actions; tapping the download icon downloads; 768px+ shows columns and icon+text; no overflow at 375/768/1280.

### Tests for User Story 2 ⚠️ write first, confirm failing before implementing

- [x] T008 [P] [US2] Update `e2e/browse.spec.ts`: Download/Share/Delete row actions selectors move from `getByRole("link", …)` to `getByRole("button", …)` (R4). Confirm failing: actions are links today.
- [x] T009 [P] [US2] Update `e2e/delete.spec.ts`: the Delete row action selector moves to `getByRole("button", { name: "Delete" })` (R4). Confirm failing.
- [x] T010 [P] [US2] Update `e2e/share.spec.ts`: the Share row action selector moves to `getByRole("button", { name: "Share" })` (R4). Confirm failing.
- [x] T011 [US2] US2 tests in `e2e/responsive.spec.ts`: at 375px a file row shows size · modified as a secondary line under the name (FR-005) and icon-only action buttons with accessible names Download/Share/Delete (FR-007); action buttons measure at least 44px tall at 375px (FR-008); tapping the download icon at 375px triggers the download (US2 sc.4); at 768px size/modified render in columns and actions show icon + text (US2 sc.2); no horizontal overflow sweep at 375/768/1280 (FR-009). Confirm failing: no stacked metadata, emoji present.

### Implementation for User Story 2

- [x] T012 [US2] Rework rows/actions in `frontend/src/components/FileListing.tsx`: replace emoji with `FileDirectoryFillIcon`/`FileIcon`; stacked size/modified line under the name below `sm` (FR-005); Download/Share/Delete become `button` elements with icon + label, text hidden below `sm`, `aria-label` matching the visible text (FR-007, R4); add `HomeIcon` to the breadcrumb Home link.
- [x] T013 [US2] Add `UploadIcon` to the picker label in `frontend/src/components/UploadControl.tsx`.

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Admin mobile + octicons (Priority: P2)

**Goal**: Admin table hidden-column values stacked under the username below their breakpoints; row actions as icon buttons with accessible names; remove-dialog octicons.

**Independent Test**: 375px tables show stacked metadata and icon actions; re-send/cancel/remove work from icon-only buttons; no overflow at any width.

### Tests for User Story 3 ⚠️ write first, confirm failing before implementing

- [x] T014 [US3] US3 tests in `e2e/responsive.spec.ts`: at 375px an invite row shows role under the username and Re-send/Cancel icon buttons with accessible names; a user row shows role/bucket/created stacked and a Remove icon button; tapping Re-send and Cancel via icons works (US3 sc.1-3); tapping Remove opens the confirmation dialog (US3 sc.4); no horizontal overflow sweep at 375/768/1280 (FR-006/007/009). Confirm failing: metadata is hidden, actions are text buttons.

### Implementation for User Story 3

- [x] T015 [US3] Rework tables/actions in `frontend/src/pages/AdminUsers.tsx`: stacked metadata lines under the username below `sm` (role) and below `md` (bucket/prefix, expires/created) (FR-006); Re-send (`PaperAirplaneIcon`), Cancel (`XIcon`), Remove (`TrashIcon`) become icon+text buttons, icon-only below `sm`, accessible names unchanged (FR-007); remove-confirmation dialog buttons get `XIcon`/`TrashIcon`.

**Checkpoint**: User Stories 1-3 all work independently.

---

## Phase 6: User Story 4 - Dialogs and auth verified on mobile (Priority: P2)

**Goal**: All four dialogs usable at 375px with octicons on their actions; sign-in and register verified at 375/768/1280.

**Independent Test**: Each dialog opens at 375px, every control visible/usable, action completes, no overflow; auth screens render without overflow at all widths.

### Tests for User Story 4 ⚠️ write first, confirm failing before implementing

- [x] T016 [US4] US4 tests in `e2e/responsive.spec.ts`: open the share dialog at 375px — controls visible, copy/done usable, no overflow; delete dialog at 375px — cancel/delete usable, confirming deletes; overwrite confirmation at 375px — cancel/replace usable; remove confirmation at 375px — cancel/remove usable; sign-in page sweep at 375/768/1280 — card centred, controls reachable, no overflow; register page (with a seeded invite token) sweep at 375/768/1280 — invite details + Create passkey visible, no overflow (FR-009, SC-002). Confirm failing: dialog buttons have no octicons and no dialog-level 375px assertions exist for delete/overwrite/remove; register has no width sweep. Confirmed: 3 failed (share/delete/overwrite octicon assertions) / 3 passed (remove icons from T015, sign-in and register sweeps) before T017 landed.

### Implementation for User Story 4

- [x] T017 [US4] Add dialog octicons: Copy/`CopyIcon` and Done/`CheckIcon` in `frontend/src/components/ShareModal.tsx`; Cancel/`XIcon` and Delete/`TrashIcon` in `frontend/src/components/DeleteDialog.tsx`; Cancel/`XIcon` and Replace/`SyncIcon` in the overwrite confirmation inside `frontend/src/components/UploadControl.tsx` (FR-004).
- [x] T018 [US4] Fix any defect the US4 sweep surfaces in `frontend/src/pages/SignIn.tsx` or `frontend/src/pages/Register.tsx` (expected: none — both are centred cards; the task exists so a failing test has an owning implementation task). No defect surfaced: both sweeps passed against the unchanged pages.

**Checkpoint**: All four user stories work independently.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story verification and cleanup.

- [x] T019 Emoji sweep: run the SC-004 grep for emoji in `frontend/src` and remove any remaining emoji characters found.
- [x] T020 Run the full e2e suite green (`bun run --cwd e2e playwright test`) and a production build (`bun run --cwd frontend build`), verifying both themes still ship (SC-003, SC-007).
- [ ] T021 Walk through `quickstart.md` scenarios against the running app (dev server at 375px + browser devtools) and tick off each one.

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; blocks all user stories.
- **User Stories (Phase 3-6)**: depend on Foundational; US1 and US2 are both P1 and independent; US3/US4 follow in priority order. `e2e/responsive.spec.ts` tasks (T003, T011, T014, T016) touch one file and run sequentially; the existing-spec updates (T008-T010) are on different files and may run in parallel with each other.
- **Polish (final)**: depends on all user stories being complete.

Within each story: tests written and failing → implementation → story green.
Tasks touching the same file run sequentially; `[P]` tasks on different files
may run together.

## Implementation Strategy

MVP first: Setup → Foundational → US1 (drawer nav, the only functional gap),
validate independently, then US2 (file browser) for the P1 pair; US3 (admin)
and US4 (dialogs/auth verification) land after. The full e2e suite is the
regression gate at every story boundary.
