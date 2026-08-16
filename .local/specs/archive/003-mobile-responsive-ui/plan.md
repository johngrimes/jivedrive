# Implementation Plan: Mobile-Responsive UI with Octicons

**Feature**: `003-mobile-responsive-ui` | **Date**: 2026-08-16 | **Spec**: [spec.md](spec.md)

## Summary

Make every screen fully usable on phones: a daisyUI drawer behind a navbar
hamburger below `lg` (permanent sidebar at `lg`+), table metadata relocated
under the primary cell instead of dropped at narrow widths, row actions as
octicon buttons (icon+text at `sm`+, icon-only below with accessible names),
emoji replaced by `@primer/octicons-react`, and all dialogs/auth screens
verified at 375/768/1280. Frontend-only; no backend, API, or data changes.

## Technical Context

**Language/Version**: TypeScript 5.x (strict; repo `tsconfig.json`), React 19.2
**Primary Dependencies**: Vite 8, Tailwind CSS 4, daisyUI 5.7, react-router 7,
`@primer/octicons-react@^19.33.0` (new — explicit user decision; peer `react
>=16.3`, ESM, zero transitive deps, tree-shakeable)
**Storage**: N/A (no data changes)
**Testing**: Playwright e2e (existing `e2e/` suite, e2eServer on 5173, CDP
virtual authenticator); no new unit-test infra (established pattern: unit
tests cover pure logic only)
**Target Platform**: Evergreen browsers (Chrome e2e), mobile-first per
constitution VI
**Project Type**: web-app (React SPA served with the API)
**Performance Goals**: N/A beyond current; icons ship only as imported (ESM
tree-shaking), no bundle growth from unused octicons
**Constraints**: No horizontal scroll at 375/768/1280; ≥44px touch targets;
both themes (corporate/business) unchanged; zero emoji in `frontend/src`;
existing e2e suite stays green with updated semantics where decided
**Scale/Scope**: 4 screens, 5 components, 1 new component (Sidebar), 1 new
e2e spec

## Constitution Check

_GATE: CLAUDE.md — re-checked after drafting the design below._

- **Simplicity (II)**: One shared `Sidebar` component rendered inside a single
  daisyUI drawer owned by `AppShell`; no dual list layouts, no new state
  library, no backend involvement. Stacked metadata is extra `<span>` lines in
  existing cells, not a second layout.
- **Test-driven development (I)**: `e2e/responsive.spec.ts` and the
  link→button selector updates in `browse/delete/share.spec.ts` are written
  first and confirmed failing against the current UI, then implementation
  lands until green.
- **Functional TypeScript (III)**: function components only; JSDoc on every
  export; plain `useState`/`useLocation` — no classes.
- **Scope containment (IV)**: no storage/route changes; the Manage users
  entry remains admin-gated in the drawer exactly as in today's sidebar.
- **Visibility of system status (V)**: sign-in state stays in the navbar at
  every width (truncated, never hidden); upload/action feedback untouched.
- **Mobile-first (VI)**: this feature is constitution VI enforcement: drawer
  nav, stacked metadata, icon actions, 44px targets, 3-width e2e sweeps.

| Violation | Why needed | Simpler alternative rejected because |
| --------- | ---------- | ------------------------------------ |
| New dependency `@primer/octicons-react` | Octicons are an explicit user decision (same justification class as daisyUI in spec 002) | Hand-copied SVG paths: zero deps but ~15 hand-maintained icon definitions and no upstream fixes |
| File row actions change role from `link` to `button` | Actions download/share/delete do not navigate; buttons are the correct semantics (user-confirmed in grilling) | Keeping links: less churn but wrong semantics for non-navigation actions |

## Project Structure

### Documentation (this feature)

```text
.local/specs/003-mobile-responsive-ui/
├── spec.md
├── plan.md            # This file.
├── research.md        # Phase 0 output.
├── quickstart.md      # Phase 1 output.
├── wireframes/        # files-mobile.html, drawer-open.html,
│                      # files-desktop.html, admin-mobile.html
├── checklists/        # requirements.md (all pass)
└── tasks.md           # Generated last.
```

No `data-model.md` (no data), no `contracts/` (no external interface).

### Source code (repository root)

```text
frontend/
├── package.json                 # + @primer/octicons-react
├── src/
│   ├── components/
│   │   ├── AppShell.tsx         # + drawer wrapper, hamburger, auto-close
│   │   ├── Sidebar.tsx          # NEW: shared nav (Files, Manage users,
│   │   │                        #   bucket/space, active state)
│   │   ├── FileListing.tsx      # octicons, stacked metadata, icon buttons
│   │   ├── UploadControl.tsx    # upload octicon, dialog octicons
│   │   ├── ShareModal.tsx       # copy/done octicons
│   │   └── DeleteDialog.tsx     # cancel/delete octicons
│   ├── pages/
│   │   ├── Files.tsx            # aside removed (drawer owns nav)
│   │   └── AdminUsers.tsx       # aside removed; stacked metadata; icon
│   │                            #   actions; remove-dialog octicons
│   └── auth/                    # untouched
└── tests/                       # untouched (pure logic only)
e2e/
├── responsive.spec.ts           # NEW: US1-US4 sweeps + drawer interactions
├── browse.spec.ts               # Download/Share/Delete → role "button"
├── delete.spec.ts               # Delete → role "button"
└── share.spec.ts                # Share → role "button"
```

**Structure Decision**: `Sidebar.tsx` is new because the drawer needs one
shared nav surface consumed from `AppShell` (which owns the drawer markup);
today each page renders its own aside, which cannot host a below-`lg` drawer
toggle in the navbar. Everything else is in-place edits to existing files,
per the repo's flat `components/` + `pages/` layout.

## Phase 0: Research

Every open technical question resolved in `research.md`:

- R1 octicons delivery: `@primer/octicons-react@^19.33.0` vs vendored SVGs.
- R2 drawer ownership: `AppShell`-owned, `useLocation`-driven auto-close.
- R3 stacked metadata technique: extra spans in the primary cell, not dual layouts.
- R4 action element semantics: links → buttons for non-navigation actions (user decision).
- R5 octicon selection per surface.
- R6 test strategy: e2e-first in one new spec + 3 existing-spec selector updates.
- R7 breakpoint unification at `lg` (user decision) and `sm` for icon labels.

## Phase 1: Design & Contracts

- **Data model**: none (no data involved).
- **Interface contracts**: none (purely internal UI work; no API/route change).
- **Quickstart** (`quickstart.md`): end-to-end scenarios for drawer
  navigation, mobile listing, admin mobile actions, dialog verification, and
  the e2e sweep command.
