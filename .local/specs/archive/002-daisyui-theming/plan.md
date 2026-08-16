# Implementation Plan: daisyUI Theming & Conversion

**Feature**: `002-daisyui-theming` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

## Summary

Rebuild the JiveDrive frontend UI on daisyUI 5 (Tailwind CSS 4): every view
and shared component moves onto daisyUI primitives, the hand-rolled
`frontend/src/index.css` (≈15 KB) is retired to a theme/configuration
stylesheet, and the **corporate** theme is applied in light mode with the
**business** theme in dark mode, following `prefers-color-scheme` via
daisyUI's `--prefersdark` flag. No manual override, no persisted preference,
no navigation or API changes. Existing e2e flows stay green; a new
`theme.spec.ts` proves the switching behavior.

## Technical Context

**Language/Version**: TypeScript (root tsconfig), React 19.2, Vite 8
**Primary Dependencies**: add `tailwindcss@^4`, `@tailwindcss/vite@^4`, `daisyui@^5` (devDependencies, frontend only); existing React + react-router-dom unchanged
**Storage**: N/A (no data changes)
**Testing**: Vitest (unit — untouched, must stay green) + Playwright e2e (must stay green; `theme.spec.ts` added)
**Target Platform**: evergreen browsers (Chrome/Edge/Firefox/Safari current); Playwright Chromium
**Project Type**: web-app (SPA)
**Performance Goals**: CSS-only theming (no JS theme switching); exactly two themes compiled
**Constraints**: mobile-first (constitution VI) — no horizontal scroll at any width, touch targets ≥ 44px; system-status visibility (constitution V); functional TS (constitution III) — no classes added
**Scale/Scope**: 4 routes, 5 shared components, 1 stylesheet; frontend only

## Constitution Check

_GATE: the constitution is the user's CLAUDE.md (global and any project-level)._

| Violation | Why needed | Simpler alternative rejected because |
| --------- | ---------- | ------------------------------------ |
| Dependency additions (Tailwind 4, `@tailwindcss/vite`, daisyUI 5) | Explicit user request: "use daisy ui for the ui". daisyUI 5 requires Tailwind 4; the Vite plugin is the standard integration. | Hand-rolled CSS (status quo) does not satisfy the request; daisyUI 4 + Tailwind 3 is an older major with config-file ceremony. |
| Legacy CSS removed in one cutover rather than incrementally | Clean cutover per constitution: no dual style vocabularies, no deprecated paths. Full conversion was the user's explicit choice. | Gradual migration leaves two competing style systems and breaks theming while both are active. |

Confirmed the design honours the standing principles:

- **Simplicity**: no new state, no JS theming, no storage. `--prefersdark`
  does the switching in CSS.
- **Test-driven development**: `theme.spec.ts` written first and confirmed
  failing before `index.css` wiring (Phase 2 → US1); e2e selector migrations
  written before the component conversions they validate; full suite re-run
  after every story.
- **Functional TypeScript**: no classes, no inheritance added; components
  keep plain-function + props structure.
- **Visibility of system status**: converted components keep visible progress
  (`progress`), success (`alert-success`), and error (`alert-error`)
  feedback; sign-in state stays in the navbar.
- **Scope enforcement (IV)**: no storage/route-layer changes; untouched.

## Project Structure

### Documentation (this feature)

```text
.local/specs/002-daisyui-theming/
├── spec.md
├── plan.md            # This file.
├── research.md        # Phase 0 output: 7 decisions.
├── quickstart.md      # Phase 1 output: end-to-end validation scenarios.
├── wireframes/        # 4 lo-fi screens (sign-in, register, files, admin-users).
├── checklists/        # requirements.md (all 13 checks pass).
└── tasks.md           # Generated last.
```

### Source code (repository root)

```text
frontend/
├── package.json            # + tailwindcss, @tailwindcss/vite, daisyui (devDeps)
├── vite.config.ts          # + tailwindcss() plugin
├── src/
│   ├── index.css           # REWRITTEN: tailwind import + daisyui plugin
│   │                       #   (corporate --default, business --prefersdark),
│   │                       #   --size-field: 0.275rem (=44px via the ×10
│   │                       #   calc), color-scheme rules,
│   │                       #   minimal custom CSS (upload dropzone styling)
│   ├── main.tsx            # unchanged
│   ├── components/
│   │   ├── AppShell.tsx    # navbar + sign-out
│   │   ├── FileListing.tsx # breadcrumbs, table, empty state, skeleton
│   │   ├── UploadControl.tsx # dropzone, progress, overwrite dialog trigger
│   │   ├── ShareModal.tsx  # modal + copy link
│   │   └── DeleteDialog.tsx# modal + confirm
│   └── pages/
│       ├── SignIn.tsx      # card + form + alerts
│       ├── Register.tsx    # card + form + alerts
│       ├── Files.tsx       # layout shell for sidebar/breadcrumbs/listing
│       └── AdminUsers.tsx  # invite card, tables, badges, modals
e2e/
├── helpers.ts              # role/text selectors replace .app-session hooks
├── theme.spec.ts           # NEW: system-preference theme switching
├── auth.spec.ts            # selectors updated; behavior unchanged
├── browse.spec.ts          # unchanged (role/text selectors already)
├── upload.spec.ts          # unchanged
├── share.spec.ts           # unchanged
├── delete.spec.ts          # unchanged
└── admin.spec.ts           # .invites-table/.users-table → getByRole("table", {name})
```

**Structure Decision**: conversion is in-place in the existing files — no new
directories, no layout restructure (IA preserved per grilling). The two
admin tables gain `aria-label` attributes ("Invites", "Users") so the e2e can
scope by table role instead of class names.

## Phase 0: Research

All decisions resolved and recorded in `research.md` (7 entries): component
library choice, theme-switching mechanism, 44px touch targets, breakpoints,
modal pattern, e2e theme assertions, e2e selector migration.

## Phase 1: Design & Contracts

- **Data model** (`data-model.md`): not produced — the feature involves no
  data (spec "Key Entities: none").
- **Interface contracts** (`contracts/`): not produced — no external
  interface changes; route paths and API contracts are explicitly out of
  scope.
- **Quickstart** (`quickstart.md`): key validation scenarios — light/dark
  rendering per screen, live preference flip, mobile widths in both themes,
  admin flows in dark mode, bundle theme count.

Key design facts (details in research.md):

1. **Theming**: `@plugin "daisyui" { themes: corporate --default, business --prefersdark; }` — corporate is the default (light), business activates under `prefers-color-scheme: dark`. CSS-only; no `data-theme` attribute, no JS.
2. **Touch targets**: `:root { --size-field: 0.275rem; }` raises buttons, inputs, selects to 44px (constitution VI) — daisyUI 5.7.17 computes `--size: calc(var(--size-field, .25rem) * 10)`, so 0.275rem × 10 = 2.75rem = 44px. Avoid `btn-sm`/`btn-xs` on primary touch controls (they set `--size` directly below 44px).
3. **Native controls**: `html { color-scheme: light; }` with a `prefers-color-scheme: dark` override so form controls, scrollbars, and autofill match the active theme.
4. **Breakpoints**: Tailwind defaults (`sm` 640, `md` 768, `lg` 1024). Files sidebar at `md+` (unchanged 768); admin sidebar moves from custom 900 → `lg` 1024 (standard grid; the 900 value was arbitrary).
5. **Modals**: keep the conditional-rendered overlay pattern with daisyUI `modal modal-open` + `modal-box` + `modal-backdrop`; preserve `role="alertdialog"` and accessible labels so e2e role queries keep working.
6. **Status/feedback**: `.error/.success/.status` → `alert alert-error/alert-success/alert-info`; upload progress → `progress progress-primary`; skeletons → `skeleton`; tags → `badge` (pending/claimed/expired).
7. **e2e theme proof**: `page.emulateMedia({ colorScheme })` + assert the computed `background-color` of `document.documentElement` equals the theme token values extracted from the compiled CSS (documented in the test). Flip mid-session asserts live switching.
