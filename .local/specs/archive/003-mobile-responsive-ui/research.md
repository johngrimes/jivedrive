# Research: Mobile-Responsive UI with Octicons

Phase 0 decisions, one entry per resolved technical question.

## R1 - Octicons delivery: npm package, not vendored SVGs

- **Decision**: Add `@primer/octicons-react@^19.33.0` to
  `frontend/package.json`; import named icon components
  (e.g. `ThreeBarsIcon`, `FileIcon`) directly.
- **Rationale**: Current latest (2026-08-04). Peer dependency `react >=16.3`
  covers React 19.2; ESM build (`dist/index.esm.mjs`) tree-shakes, so only
  used icons ship. Zero transitive dependencies — the smallest possible
  dependency footprint for the explicit octicons requirement.
- **Alternatives considered**: (a) Vendoring the ~15 SVG paths into a local
  `icons` module — zero deps, but hand-maintained icon data and no upstream
  fixes, rejected in grilling. (b) Icon font — no tree-shaking, font-loading
  shift, weaker a11y control, rejected.

## R2 - Drawer ownership: AppShell, location-driven auto-close

- **Decision**: `AppShell` renders the daisyUI `drawer lg:drawer-open`
  wrapper around the `<Outlet/>`; a controlled checkbox (`useState`) drives
  the drawer; an effect on `useLocation()` resets it after every navigation.
  The hamburger (`ThreeBarsIcon` + accessible label) renders only when a
  session exists (below `lg`).
- **Rationale**: One drawer per app (not per page) means one checkbox id, one
  toggle, one close rule — pages stay drawer-free. `useLocation` is the
  router-native signal for "navigated", so closing after navigation is a
  three-line effect, no callback threading through pages (FR-011).
- **Alternatives considered**: (a) Per-page drawer markup like daisyUI's docs
  example — duplicates the toggle/sidebar on both pages and the navbar
  hamburger has to live inside page content, not the shell. (b) Uncontrolled
  checkbox + `label` links — daisyUI's native pattern cannot guarantee close
  after navigation, which FR-011 requires.

## R3 - Stacked metadata: spans in the primary cell, no dual layout

- **Decision**: File listing: below `sm` the name cell renders the size and
  modified date as a small second line (`hidden sm:inline` inverse). Admin
  tables: role (`hidden sm:table-cell` today) renders under the username
  below `sm`; bucket/prefix + expires/created (`hidden md:table-cell` today)
  render as another line below `md`. Table markup, headers and row structure
  stay intact at every width.
- **Rationale**: One DOM tree, CSS-only relocation — no second card layout to
  build/test (simplicity), table semantics and e2e `tbody tr` selectors keep
  working.
- **Alternatives considered**: Separate card list below `sm` — best visual
  control but dual code paths for the same data, rejected in grilling.

## R4 - Action element semantics: links → buttons

- **Decision**: File row actions (Download/Share/Delete) become `<button>`
  elements (daisyUI `btn btn-ghost` styling); folder rows stay links (they
  navigate). Admin actions are already buttons. e2e selectors in
  `browse.spec.ts`, `delete.spec.ts`, `share.spec.ts` move from
  `getByRole("link", …)` to `getByRole("button", …)` for these three actions.
- **Rationale**: Non-navigation actions are buttons semantically; screen
  readers and AT users benefit. User-confirmed in grilling over the
  keep-links option.
- **Alternatives considered**: Keep `<a href="#">` — less churn but wrong
  semantics, and the icon-only mobile design makes the distinction more
  visible.

## R5 - Octicon selection per surface

- **Decision** (all names exist in octicons 19.x; build fails loudly if not):

| Surface | Icon |
| --- | --- |
| Navbar hamburger | `ThreeBarsIcon` |
| Sign out | `SignOutIcon` |
| Folder row | `FileDirectoryFillIcon` |
| File row | `FileIcon` |
| Download | `DownloadIcon` |
| Share | `ShareAndroidIcon` |
| Delete (rows + dialog) | `TrashIcon` |
| Upload button | `UploadIcon` |
| Breadcrumb Home | `HomeIcon` |
| Copy link | `CopyIcon` |
| Done | `CheckIcon` |
| Cancel (dialogs) | `XIcon` |
| Replace (overwrite) | `SyncIcon` |
| Re-send invite | `PaperAirplaneIcon` |
| Cancel invite | `XIcon` |
| Remove user | `TrashIcon` |

- **Rationale**: Conventional GitHub-semantics icons; each is decorative
  (`aria-hidden`) while the control carries its accessible name via visible
  text or `aria-label`.
- **Alternatives considered**: A curated minimal subset (e.g. reusing one
  arrow for all actions) — worse scanability for no real saving.

## R6 - Test strategy: one new e2e spec, e2e-first

- **Decision**: New `e2e/responsive.spec.ts` holds US1-US4 tests: drawer
  interactions (open → navigate → closes; admin-only entry; permanent sidebar
  at `lg`), mobile listing (stacked metadata, icon-only actions, download via
  icon at 375px), admin mobile (stacked metadata, icon actions working), and
  dialog/auth sweeps at 375/768/1280. Written first and confirmed failing
  against today's UI (no hamburger, emoji present, no stacked metadata).
  Existing specs updated for button semantics in the same test-first wave.
  No new Playwright project — per-test `setViewportSize` matches the
  established pattern.
- **Rationale**: The project verifies UI behaviour with Playwright only;
  adding Vitest + testing-library would introduce two dev dependencies and a
  parallel test style for marginal value (rejected in grilling).
- **Alternatives considered**: Mobile Playwright device project (doubles e2e
  wall time); scattering responsive checks across existing specs (fragmented).

## R7 - Breakpoint unification

- **Decision**: Sidebar/drawer boundary at `lg` on both pages (Files moves
  from `md`); icon-only row actions below `sm`, icon+text at `sm`+; stacked
  metadata mirrors the columns' existing breakpoints (`sm` for size/modified
  and role; `md` for bucket/prefix/expires/created).
- **Rationale**: One navigation rule and one label rule — both user-confirmed
  in grilling; metadata breakpoints preserve today's information hierarchy.
- **Alternatives considered**: Keeping Files at `md` (inconsistent drawer
  boundary); always-visible text labels (mobile crowding).
