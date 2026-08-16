# Feature Specification: Mobile-Responsive UI with Octicons

**Feature**: `003-mobile-responsive-ui`
**Created**: 2026-08-16
**Status**: Draft

## Problem

The daisyUI conversion (spec 002) fixed theming and touch-target sizing, but the
UI is still desktop-shaped. On a phone: the sidebar — the only place the
"Manage users" link lives — is hidden (`hidden md:block`), so an admin cannot
reach `/admin` at all; the file listing shows emoji icons (📁 📄) and cramped
text action links; table columns (size, modified, role, bucket/prefix, expiry)
are simply dropped below their breakpoints instead of being relocated; and the
navbar's sign-in state can overflow with long usernames. The UI must render
well on mobile devices: every view fully usable at 375px with no horizontal
scrolling or unreachable content (constitution VI), real navigation on phones,
Octicons replacing emoji throughout, and daisyUI components used for the new
surfaces (drawer, menu).

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Responsive navigation: drawer + permanent sidebar (Priority: P1)

A signed-in user on any width can reach every page. Below `lg` a hamburger
button in the navbar opens a daisyUI drawer containing the same navigation a
desktop user sees in the permanent sidebar: Files, Manage users (admins only),
bucket and space info. At `lg` and up the drawer is permanently open as the
sidebar. The sign-in state ("Signed in as `<username>`" + sign-out) stays
visible in the navbar at every width; long usernames truncate instead of
overflowing.

**Why this priority**: Mobile navigation is the only functional gap — today an
admin on a phone cannot reach the admin screen at all. Everything else is
rendering quality on top of reachable screens.

**Independent Test**: At 375px a signed-in admin opens the drawer via the
hamburger, taps "Manage users", and lands on `/admin`; at 1280px the same
navigation renders as a permanent sidebar with no hamburger; the navbar shows
the sign-in state at every width with no overflow.

**Acceptance Scenarios**:

1. **Given** a signed-in admin at 375px, **When** they tap the hamburger
   button, **Then** a drawer opens showing Files, Manage users, bucket and
   space info; tapping Manage users navigates to `/admin` and the drawer
   closes.
2. **Given** a signed-in non-admin at 375px, **When** they open the drawer,
   **Then** the Manage users link is absent (same rule as today's sidebar).
3. **Given** any signed-in user at 1280px, **When** the page renders, **Then**
   the sidebar is permanently visible and the hamburger button is absent.
4. **Given** a signed-in user with a long username, **When** the navbar renders
   at 375px, **Then** the username truncates with an ellipsis and the page has
   no horizontal scroll; the sign-in state remains visible (constitution V).
5. **Given** a signed-out visitor at 375px, **When** the app renders, **Then**
   the navbar shows the brand and the Sign in link without overflow; no
   hamburger appears (no drawer content when signed out).

### User Story 2 - File browser rendered for mobile, with octicons (Priority: P1)

The file browser works well on a phone. Folder/file rows use Octicons
(folder/file icons) instead of emoji. On narrow widths the Size and Modified
values move under the name as a small secondary line instead of vanishing.
Actions become octicon buttons — icon plus text at `sm` and up, icon-only with
accessible labels below `sm` — with touch targets at least 44px tall. The
breadcrumb Home link, the upload button, and the copy/done actions in dialogs
get octicons too.

**Why this priority**: The file browser is the primary working screen. Same
priority as US1 — both land before the feature is useful on a phone.

**Independent Test**: At 375px the listing shows name, size/modified as a
secondary line, and icon-only actions; a tap on the download icon starts the
download; at 1280px the table shows columns and icon+text actions; the full
browse/upload/share/delete e2e flows pass with no overflow at 375/768/1280.

**Acceptance Scenarios**:

1. **Given** the file listing at 375px, **When** a file row renders, **Then**
   the name is followed by a secondary line with its size and modified date,
   and the download/share/delete actions are icon buttons with accessible
   names ("Download", "Share", "Delete").
2. **Given** the file listing at 768px or wider, **When** a file row renders,
   **Then** size and modified appear in their own columns and actions show
   icon + text.
3. **Given** a folder row, **When** it renders, **Then** it shows a folder
   octicon, is clickable, and never shows file actions.
4. **Given** a signed-in user at 375px, **When** they tap the download icon,
   **Then** the file downloads exactly as the text link did today.
5. **Given** the toolbar at 375px, **When** it renders, **Then** the item
   count and the upload button (with octicon) are both visible and usable,
   with no overflow.
6. **Given** long folder/file names at 375px, **When** rows render, **Then**
   names wrap and the page has no horizontal scroll.

### User Story 3 - Admin screen rendered for mobile, with octicons (Priority: P2)

The admin screen works well on a phone. Invite and user rows keep their
essential cells; hidden column values (role below `sm`; bucket/prefix, expires,
created below `md`) render as secondary lines under the username instead of
being dropped. Row actions become octicon buttons with accessible names
(Re-send, Cancel, Remove), icon+text at `sm` and up, icon-only below. The
invite form and generated-link card already stack and stay as they are.

**Why this priority**: Admin-only surface, used less often than the file
browser; lands after the primary flows.

**Independent Test**: At 375px the invites/users tables show stacked metadata
and icon actions with no overflow; re-send, cancel and remove all work from
icon-only buttons; at 1280px columns and icon+text actions render as before.

**Acceptance Scenarios**:

1. **Given** the invites table at 375px, **When** a row renders, **Then** the
   username is followed by its role as a secondary line, and Re-send/Cancel
   are icon buttons with accessible names.
2. **Given** the invites table at 375-767px, **When** a row renders, **Then**
   bucket/prefix and expiry appear under the username; at `md` and up they
   return to their own columns.
3. **Given** the users table at 375px, **When** a row renders, **Then** the
   username is followed by role, bucket/prefix and created as secondary lines,
   and Remove is an icon button with the accessible name "Remove".
4. **Given** an admin at 375px, **When** they tap the remove icon, **Then**
   the confirmation dialog opens and behaves exactly as today.
5. **Given** the admin screen at every supported width, **When** it renders,
   **Then** there is no horizontal scrolling in either theme.

### User Story 4 - Dialogs and auth screens verified on mobile (Priority: P2)

All four dialogs (share, delete, overwrite confirmation, remove confirmation)
and both auth screens (sign-in, register) are exercised at mobile, tablet and
desktop widths. Dialog action buttons get octicons (copy, done, cancel,
delete, replace). No layout change is expected on auth screens — they already
render as centred cards — this story proves it at every width.

**Why this priority**: Verification-heavy story; the screens are already
card/modal based, so expected effort is tests plus small icon additions.

**Independent Test**: The responsive sweep opens each dialog at 375px and
completes its action; sign-in and register render without overflow at
375/768/1280.

**Acceptance Scenarios**:

1. **Given** the share dialog at 375px, **When** it opens, **Then** every
   control is visible and usable; copy and done buttons carry octicons and
   keep their accessible names.
2. **Given** the delete dialog at 375px, **When** it opens, **Then** cancel
   and delete are usable; confirming deletes the file.
3. **Given** the overwrite confirmation at 375px, **When** it opens, **Then**
   cancel and replace are usable; replacing completes the upload.
4. **Given** the remove confirmation at 375px, **When** it opens, **Then**
   cancel and remove are usable; removing completes the action.
5. **Given** the sign-in page, **When** rendered at 375/768/1280, **Then**
   the card is centred, every control is reachable, and there is no horizontal
   scroll.
6. **Given** the register page with an invite token, **When** rendered at
   375/768/1280, **Then** the invite details and Create passkey button are
   visible and usable with no horizontal scroll.

### Edge Cases

- A username longer than the navbar space at 375px → truncates with an
  ellipsis; the page must not scroll horizontally.
- A deep folder path with many breadcrumb segments at 375px → breadcrumbs
  wrap; no horizontal scroll, no clipped content.
- File/folder names with spaces, special characters, or very long tokens →
  rows wrap without breaking the layout; actions stay reachable.
- The drawer must work in both themes (corporate and business) and must not
  introduce horizontal scroll while open.
- Keyboard users: the hamburger and every drawer link must be focusable and
  show visible focus in both themes.
- The drawer must close after navigating; it must not stay open covering the
  destination screen.
- Non-admin users must never see the Manage users entry in the drawer
  (constitution IV: no admin surface, and no leaked navigation).
- Every icon-only button must carry an accessible name identical to today's
  visible label, so the e2e suite's role-based selectors keep resolving and
  screen readers announce the action.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: Below `lg`, every signed-in screen MUST render a hamburger
  button in the navbar that opens a daisyUI drawer containing Files, Manage
  users (admins only), and the bucket/space info. At `lg` and up the same
  content MUST render as a permanently open sidebar and the hamburger MUST be
  absent.
- **FR-002**: The Manage users entry MUST be reachable from a mobile device
  by a signed-in admin, and MUST be hidden for non-admins at every width.
- **FR-003**: The navbar MUST show the sign-in state ("Signed in as
  `<username>`" and the sign-out control) at every supported width
  (constitution V); long usernames MUST truncate rather than overflow.
- **FR-004**: Octicons MUST replace all emoji in the UI (folder/file icons)
  and MUST be used for: navbar hamburger, sign-out, upload button, breadcrumb
  Home, table row actions (download, share, delete, re-send, cancel, remove),
  and dialog actions (copy, done, cancel, delete, replace). No emoji
  characters may remain in the frontend source.
- **FR-005**: In the file listing below `sm`, Size and Modified MUST render as
  a secondary line under the file name instead of disappearing; at `sm` and up
  they MUST render in their own columns.
- **FR-006**: In the admin tables, values of breakpoint-hidden columns MUST
  render as secondary lines under the username cell below their breakpoints
  (role below `sm`; bucket/prefix, expires, created below `md`) instead of
  being dropped; at the breakpoint and up they MUST return to their columns.
- **FR-007**: Row action controls (file and admin tables) MUST be icon+text at
  `sm` and up, and icon-only below `sm`; every icon-only control MUST have an
  accessible name identical to today's text label.
- **FR-008**: Every interactive control MUST keep a touch target at least
  44px tall, in both themes, at every width.
- **FR-009**: No screen — sign-in, register, files, admin — and no open
  dialog or drawer MAY cause horizontal scrolling at 375px, 768px, or 1280px
  in either theme.
- **FR-010**: All existing functionality MUST be preserved: WebAuthn
  sign-in/register, file listing/download/upload with progress and overwrite
  confirmation, share-link generation, delete confirmation, admin invite and
  user management, and system-status feedback (constitution V).
- **FR-011**: The drawer MUST close after the user navigates from it.
- **FR-012**: No backend, API, route, or data-model change is in scope.

### Key Entities

None — this feature introduces and changes no data.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A signed-in admin at 375px can navigate from `/files` to
  `/admin` using only the drawer (e2e assertion).
- **SC-002**: The responsive e2e sweep passes: sign-in, register, files and
  admin render with no horizontal scroll at 375px/768px/1280px, with each
  dialog open at 375px, in both themes.
- **SC-003**: The full existing e2e suite (auth, browse, upload, share,
  delete, admin, theme, listing-error) passes unchanged in behaviour.
- **SC-004**: `grep` for emoji characters in `frontend/src` returns zero
  matches.
- **SC-005**: Interactive controls keep their ≥44px touch targets (existing
  `--size-field` mechanism preserved; e2e/visual spot check).
- **SC-006**: The drawer is closed after navigating from it, on mobile.
- **SC-007**: Production build succeeds and the bundle stays on the two
  configured themes (spec 002 behaviour unchanged).

## User Interface

Four screens exist; this feature adds the drawer/sidebar navigation and
re-renders rows/actions. Grayscale wireframes (lo-fi; actual themes apply
corporate/business colors):

- **Files (mobile)**: 375px view: navbar with hamburger and truncating
  sign-in state; breadcrumbs; toolbar with item count and upload button;
  listing rows with stacked size/modified and icon-only actions. Drawer
  closed; annotated link opens the drawer state. Wireframe:
  `wireframes/files-mobile.html`
- **Files (drawer open)**: Same page with the drawer panel overlaid: Files,
  Manage users, bucket/space info. Wireframe: `wireframes/drawer-open.html`
- **Files (desktop)**: 1280px view: permanent sidebar, full table columns,
  icon+text actions. Wireframe: `wireframes/files-desktop.html`
- **Admin (mobile)**: 375px view: invite form stacked, invites/users tables
  with stacked metadata under the username and icon-only actions; remove
  confirmation annotated. Wireframe: `wireframes/admin-mobile.html`

## Assumptions

- Mobile means the existing supported width set (375px phone, 768px tablet,
  1280px desktop) already used by the e2e suite; nothing below 375px must be
  supported.
- The desktop sidebar breakpoint unifies at `lg` on both Files (currently
  `md`) and Admin (currently `lg`); one consistent rule, confirmed in
  grilling.
- `@primer/octicons-react` is an acceptable new dependency: it is an explicit
  user decision, justifying it under the constitution's dependency rule the
  same way daisyUI was justified in spec 002.
- Row actions being icon-only below `sm` with aria-labels preserves
  accessibility and e2e role selectors; visual text labels return at `sm`.
- Auth screens need no layout redesign; they are verified, not rebuilt.
- No new Playwright device project: responsive behaviour is asserted with
  per-test viewport sweeps, matching the existing specs' pattern.
