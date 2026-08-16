# Feature Specification: daisyUI Theming & Conversion

**Feature**: `002-daisyui-theming`
**Created**: 2026-08-16
**Status**: Draft

## Problem

JiveDrive's UI is styled by a hand-rolled stylesheet (`frontend/src/index.css`,
~15 KB) that hard-codes its own color palette. There is no light/dark mode.
The UI must be rebuilt on daisyUI — with the **corporate** theme in light mode
and the **business** theme in dark mode — switching automatically according to
the system preference. The conversion is full: every view and component moves
onto daisyUI primitives and the legacy stylesheet is retired, otherwise the
two style systems fight and the themes cannot take effect.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Theme foundation: system-following light/dark (Priority: P1)

The app is wired to daisyUI and the two themes, and the active theme follows
the operating system's color-scheme preference. In light mode the UI renders
in `corporate`; in dark mode it renders in `business`; the switch happens
automatically and immediately when the system preference changes, with no
reload and no manual control.

**Why this priority**: Theming is the core of the request. Everything else is
restyling that must be verified inside the correct theme. Without this story
there is no feature.

**Independent Test**: In an e2e browser, emulate a light color scheme and
assert the applied theme is `corporate`; emulate dark and assert `business`;
flip the emulation while on a screen and assert the applied theme changes
without a reload.

**Acceptance Scenarios**:

1. **Given** a browser emulating a light color scheme, **When** any screen
   loads, **Then** the applied theme is `corporate`.
2. **Given** a browser emulating a dark color scheme, **When** any screen
   loads, **Then** the applied theme is `business`.
3. **Given** any screen rendered, **When** the emulated system preference
   flips from light to dark, **Then** the applied theme changes to `business`
   with no reload or user action.
4. **Given** a system preference of "no preference", **When** any screen
   loads, **Then** the applied theme is `corporate` (light default).

### User Story 2 - Shell and auth screens on daisyUI (Priority: P1)

The persistent app shell (header with sign-in state) and the sign-in and
register screens are rebuilt with daisyUI primitives: navbar, card, input,
btn, label, alert. Sign-in state remains visible on every page; every auth
action still surfaces explicit success or failure feedback.

**Why this priority**: Every visitor passes through these screens, and the
header is visible on every page — the most visible part of the conversion.

**Independent Test**: e2e auth flow (WebAuthn sign-in, sign-out) passes with
the converted components; header state text is unchanged; sign-in errors show
as visible alerts.

**Acceptance Scenarios**:

1. **Given** a signed-out visitor, **When** they open the app, **Then** the
   header shows the sign-in link and the sign-in card is rendered with
   daisyUI components.
2. **Given** a signed-in user, **When** they sign out, **Then** the header
   returns to the signed-out state and the sign-in screen is shown.
3. **Given** an invalid sign-in attempt, **When** the user submits, **Then** a
   visible error alert explains the failure (constitution V).
4. **Given** a signed-in user on any page, **When** the page renders, **Then**
   the header shows "Signed in as `<username>`" (constitution V).

### User Story 3 - File browser on daisyUI (Priority: P1)

The file browser — breadcrumbs, folder/file listing, load more, download,
upload with progress, overwrite confirmation, and share dialog — is rebuilt
with daisyUI primitives: breadcrumbs, table, btn, badge, menu/sidebar,
modal, progress, skeleton, alert. Upload progress is still visible; every
action still surfaces success or failure.

**Why this priority**: The file browser is the primary working screen for
every signed-in user; it exercises the widest range of components.

**Independent Test**: e2e browse, upload (with overwrite confirmation), share,
and delete flows pass against the converted UI, including the mobile-width
(375px) no-horizontal-scroll assertions.

**Acceptance Scenarios**:

1. **Given** a signed-in user in a folder, **When** the listing renders,
   **Then** folders and files appear in a table with size, timestamp, and
   action links (download/share/delete) — no horizontal scrolling at any
   supported width.
2. **Given** a signed-in user uploading a file, **When** the upload runs,
   **Then** progress is shown and "Uploaded `<name>`" appears on success
   (constitution V).
3. **Given** a signed-in user uploading a file that already exists, **When**
   they confirm overwrite, **Then** the file is replaced; when they cancel,
   **Then** the stored object is untouched.
4. **Given** a signed-in user sharing a file, **When** the dialog opens,
   **Then** the generated one-time share link is displayed with copy affordance
   and default 7-day expiry; the dialog is fully usable at 375px width.
5. **Given** a signed-in user deleting a file, **When** the confirmation
   dialog is answered, **Then** deletion is permanent and the outcome is
   reported; cancel leaves the row in place.
6. **Given** an empty folder, **When** it renders, **Then** a friendly empty
   state is shown, not an error.

### User Story 4 - Admin user management on daisyUI (Priority: P2)

The admin screen — invite creation, invite status badges, users table, removal
confirmation — is rebuilt with daisyUI primitives: table, badge, btn,
checkbox, input, modal, alert. The generated invite link remains copyable;
every action still surfaces success or failure.

**Why this priority**: Admin-only surface used less often than the file
browser; it can land after the primary flows.

**Independent Test**: e2e admin flow (invite create/resend/cancel, link
copy, user removal) passes against the converted UI.

**Acceptance Scenarios**:

1. **Given** an admin on the admin screen, **When** they create or re-send
   an invite, **Then** the generated link is shown in a copyable field with
   a visible success message.
2. **Given** an admin viewing the invites table, **When** it renders, **Then**
   each invite shows its status as a clear badge (pending/claimed/expired).
3. **Given** an admin removing a user, **When** they confirm in the
   confirmation dialog, **Then** the removal completes and the outcome is
   reported; cancel leaves the user in place.
4. **Given** a signed-in non-admin visiting `/admin`, **When** the page
   renders, **Then** a clear access-denied message is shown (no data leaked).
5. **Given** the invites/users tables render, **When** viewed at admin
   breakpoints, **Then** the columns never cause horizontal scrolling.

### Edge Cases

- System color-scheme preference is "no preference" → `corporate` (light)
  is applied; dark never appears spuriously.
- The preference changes while the app is open → the theme updates live via
  CSS; no reload, no lost state, no flicker of a hard-coded palette.
- A browser without `prefers-color-scheme` support → renders `corporate`
  (graceful degradation; evergreen browsers all support it).
- Every daisyUI interaction retains its accessible name/label so the e2e
  suite's role- and label-based selectors keep resolving.
- Focus visibility must be preserved in both themes (keyboard users can see
  where they are in light and dark).
- The conversion must not change route paths, API contracts, or any backend
  behavior.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Every view (SignIn, Register, Files, Admin) and every shared
  component (AppShell, FileListing, UploadControl, ShareModal, DeleteDialog)
  MUST be rebuilt using daisyUI components; the legacy hand-rolled class
  vocabulary in `frontend/src/index.css` MUST be removed, leaving at most the
  theme configuration and a minimal set of genuinely custom rules.
- **FR-002**: The light color scheme (system preference) MUST render the
  **corporate** theme; the dark color scheme MUST render the **business**
  theme.
- **FR-003**: Theme selection MUST follow the system preference automatically,
  with no manual override control and no persisted preference.
- **FR-004**: A change in system preference MUST apply to the open app
  immediately, without reload or navigation.
- **FR-005**: All existing functionality MUST be preserved: sign-in/register
  (WebAuthn), file listing/download/upload, overwrite confirmation, share-link
  generation, delete confirmation, admin invite and user management.
- **FR-006**: The UI MUST remain mobile-first: no horizontal scrolling at any
  supported width (mobile/tablet/desktop) in either theme, and touch targets
  on interactive controls MUST be at least 44px tall.
- **FR-007**: System-status visibility MUST be preserved (constitution V):
  upload progress, explicit success and failure feedback, visible sign-in
  state — restyled, not removed.
- **FR-008**: Interactive elements MUST keep accessible roles, labels, and
  names equivalent to today (buttons, links, inputs with labels, dialogs with
  dialog/alertdialog roles, tables with headers).
- **FR-009**: Only the two required themes are compiled into the shipped
  bundle; unused daisyUI theme data MUST NOT be shipped.
- **FR-010**: No backend, API, route, or data-model change is in scope.

### Key Entities

None — this feature introduces and changes no data.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: With a light color scheme emulated, the applied theme on every
  screen is `corporate`; with dark, it is `business` (e2e assertion on the
  root element).
- **SC-002**: Flipping the emulated system preference on an open screen
  changes the applied theme without a reload, on every screen.
- **SC-003**: The full existing e2e suite (auth, browse, upload, share,
  delete, admin) passes against the converted UI with no behavioral change.
- **SC-004**: The no-horizontal-scroll checks at 375px, tablet, and desktop
  widths pass in both themes on the file browser and admin screens.
- **SC-005**: `frontend/src/index.css` shrinks from ~15 KB of component
  styles to the daisyUI/theme configuration plus a handful of custom rules
  (target: < 100 lines), and no legacy component class names remain in the
  JSX.
- **SC-006**: Interactive controls measure ≥ 44px in height in both themes.
- **SC-007**: The production bundle contains exactly the two configured
  themes (corporate, business), verified by a build output inspection or test.

## User Interface _(include only if the feature has a UI)_

All four existing screens are restyled; information architecture and flows are
unchanged. Grayscale wireframes (lo-fi; actual themes apply corporate/business
colors):

- **Sign in**: Centred card with username input and "Continue with passkey"
  button; error alert area. Wireframe: `wireframes/sign-in.html`
- **Register**: Centred card with username input and "Create account" button;
  error alert area. Wireframe: `wireframes/register.html`
- **Files**: Navbar header with sign-in state; sidebar (space name, scope,
  "Browse files", "Admin" when admin); breadcrumbs; toolbar with upload
  control and item count; file table (name/size/modified/actions) or
  skeletons; load-more; empty state. Modals annotated: share link, overwrite
  confirmation, delete confirmation, upload progress. Wireframe:
  `wireframes/files.html`
- **Admin users**: Sidebar; invite creation card (username, role, scope,
  expiry) with generated-link output; invites table with status badges; users
  table with remove actions; removal confirmation. Wireframe:
  `wireframes/admin-users.html`

## Assumptions

- A visual refresh is acceptable and expected: the goal is the daisyUI
  corporate/business look, not pixel-identical reproduction of the current
  custom design. Layout, content, and flows stay the same.
- "System preference" means the operating system / browser
  `prefers-color-scheme` value; no manual override is added (explicitly
  confirmed).
- The conversion targets evergreen browsers; no fallback styling is required
  for browsers lacking `prefers-color-scheme`.
- daisyUI and its required Tailwind CSS are acceptable new dependencies —
  the daisyUI requirement is an explicit user decision that justifies them
  under the constitution's dependency rule.
- The e2e suite's class-based selectors (`.app-session`, `.app-session-user`,
  `.invites-table`, `.users-table`) will be migrated to role- and
  label-based selectors as part of this feature (test-first), not preserved
  as legacy hooks.
