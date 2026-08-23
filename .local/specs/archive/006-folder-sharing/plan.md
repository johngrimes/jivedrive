# Implementation Plan: Folder Sharing

**Feature**: `006-folder-sharing` | **Date**: 2026-08-23 | **Spec**: [spec.md](spec.md)

## Summary

Persistent, revocable user-to-user folder grants (full read/write: browse,
download, upload/overwrite, delete), implemented as a **generic space
resolver refactor**: every `/api/files` operation carries an explicit
`space` identifier (`own` | `shared:<shareId>`); a resolver in the route
layer maps the space to the effective bucket/prefix (the sharer's bucket +
shared folder for shared spaces) and enforces authorization (share exists,
caller is the recipient). Shares are SQLite records (migration 004),
managed via new `/api/shares` routes, picked via a new authenticated user
search `/api/users`. The SPA mounts incoming shares at the recipient's space
root with a "Shared by \<username\>" label, and folder rows gain a share
dialog (add recipient, list recipients, revoke). The constitution's
fire-and-forget clause is amended to cover only anonymous share links.

## Technical Context

**Language/Version**: TypeScript 5.x on bun 1.3.x (repo standard, functional
style, no classes)
**Primary Dependencies**: Hono 4, @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner,
bun:sqlite, React 18 + Vite + daisyUI 5. No new dependencies.
**Storage**: SQLite via numbered migrations (new `004_shares.sql`), accessed
through the existing repository pattern; shares cascade with user deletion.
**Testing**: bun:test backend (`backend/tests/*.test.ts`), Vitest frontend,
Playwright e2e against the mock-S3 e2e server (seeded second user `bob`).
**Target Platform**: Browser SPA + same-container Hono API, Kubernetes/Helm
deployment unchanged (migration applies at startup).
**Project Type**: web-app (SPA + REST API)
**Performance Goals**: shares are small indexed lookups per request; listing
page size and presign TTLs unchanged (15 min download/upload).
**Constraints**: constitution I (test-first), II (simplicity, no new deps),
III (functional TS), IV (scope enforcement in the route layer, tested),
V (visibility of system status), VI (mobile-first e2e at 3 widths).
**Scale/Scope**: personal drive, handful of users; no pagination for share
lists; user search capped at 20 results.

## Constitution Check

_GATE: the constitution is the user's CLAUDE.md. Re-checked after design._

| Violation | Why needed | Simpler alternative rejected because |
| --------- | ---------- | ------------------------------------ |
| "Share links are fire-and-forget: generated, displayed, and never stored, listed, or revoked" | User-to-user grants are a different mechanism: they must persist, be listed back to the owner, and be revocable. The user approved amending the clause so it applies only to **anonymous share links** (CLAUDE.md task in Polish). | Keeping the clause literal would forbid the feature entirely or force a crippled "revoke without listing" mode that fails the constitution's own Visibility principle. |

- **Test-first**: every behaviour below is a test task that precedes its
  implementation task and is confirmed failing first.
- **Simplicity**: one new table, four new endpoints, one resolver function.
  The resolver refactor is the design the user chose; it replaces
  accumulating special-case branches in four routes with one scope authority
  (strengthens constitution IV).
- **Language/framework rules**: functional TypeScript, Hono route modules,
  repository pattern, migration runner — all existing conventions reused.
- **Visibility**: share dialog shows live recipient list and revoke feedback;
  mounts appear/disappear on next load; refused requests surface explicit
  errors.
- **Mobile-first**: new e2e flows exercised at mobile, tablet, desktop.

## Project Structure

### Documentation (this feature)

```text
.local/specs/006-folder-sharing/
├── spec.md
├── plan.md            # This file.
├── research.md        # Phase 0 output.
├── data-model.md      # Phase 1 output.
├── quickstart.md      # Phase 1 output.
├── contracts/         # Phase 1 output.
├── checklists/        # Quality checklists.
└── tasks.md           # Generated last.
```

### Source code (repository root)

```text
backend/
├── migrations/004_shares.sql          # shares table + indexes
├── src/
│   ├── scope.ts                       # NEW: SpaceRef parsing + resolveSpace
│   ├── routes/shares.ts               # NEW: GET/POST /api/shares, DELETE /api/shares/:id
│   ├── routes/users.ts                # NEW: GET /api/users?q= search
│   ├── routes/files.ts                # all ops take space; resolver replaces direct user scope
│   ├── db/repository.ts               # share CRUD (create/list/listByRecipient/delete)
│   ├── server.ts                      # mount new routes + rate-limit families
│   └── e2eServer.ts                   # seed bob (second non-admin user)
├── tests/
│   ├── routes-shares.test.ts          # NEW
│   ├── scope.test.ts                  # NEW
│   └── routes-files.test.ts           # space-aware cases added
frontend/
├── src/
│   ├── api/client.ts                  # space-aware file fns + shares/users fns
│   ├── pages/Files.tsx                # space state, mounts at root, share wiring
│   ├── components/ShareDialog.tsx     # NEW: add/revoke recipients, user search
│   ├── components/FileListing.tsx     # shared rows, folder share button, Shared chip
│   ├── components/UploadControl.tsx   # space prop
│   └── components/DeleteDialog.tsx    # space prop
e2e/
└── share-folder.spec.ts               # NEW: US1-US4 flows incl. 3 widths
scripts/verify-folder-share.sh         # NEW: curl validation of the share API
CLAUDE.md                              # constitution amendment (Polish)
README.md                              # feature bullet (Polish)
.local/specs/006-folder-sharing/contracts/openapi.yaml   # v1.3.0
```

**Structure Decision**: follows the existing module layout exactly — one
route module per resource, repository functions in `db/repository.ts`, the
resolver as a small pure module (`src/scope.ts`) consumed by the files
routes. No new directories or layers.

## Phase 0: Research

Resolved questions recorded in [research.md](research.md): space encoding
and resolver design, mount-relative keys, share identity and uniqueness,
user search shape, shares listing shape, revocation enforcement, rate-limit
mounting, error codes, shared-space anonymous links, e2e seeding, contract
version.

## Phase 1: Design & Contracts

- **Data model** ([data-model.md](data-model.md)): `shares` entity —
  id, ownerUserId, recipientUserId, folder (normalised relative prefix),
  createdAt; unique (owner, recipient, folder); cascade on user deletion;
  lifecycle created → revoked.
- **Interface contracts** ([contracts/openapi.yaml](contracts/openapi.yaml)):
  v1.3.0 superseding v1.2.0 — `space` parameter on all `/api/files`
  operations; new `/api/shares` (GET list incoming+outgoing, POST create,
  DELETE revoke) and `/api/users` (GET search); `Share` and `UserSummary`
  schemas.
- **Quickstart** ([quickstart.md](quickstart.md)): end-to-end scenarios:
  share → mount → browse/download → upload/overwrite/delete → revoke →
  cascade cleanup.
