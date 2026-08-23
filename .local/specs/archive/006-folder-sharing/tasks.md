# Tasks: Folder Sharing

**Input**: Design documents in `.local/specs/006-folder-sharing/`
**Prerequisites**: plan.md (required), spec.md (required for user stories); research.md, data-model.md, contracts/openapi.yaml (present).

**Tests**: Test-driven development is mandatory. Every behaviour is covered by a
test task that precedes its implementation task, and those tests must be written
to fail first.

**Organisation**: Tasks are grouped by user story so each story can be
implemented and tested independently.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks).
- **[Story]**: the user story a task belongs to (US1..US5); omitted for Setup, Foundational, and Polish.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The shares table and its repository access.

- [x] T001 [P] Migration `004_shares.sql`: shares table (id, ownerUserId, recipientUserId, folder, createdAt), FKs to users with ON DELETE CASCADE both ways, unique index (ownerUserId, recipientUserId, folder), indexes on ownerUserId and recipientUserId in `backend/migrations/004_shares.sql`.
- [x] T002 [P] Migration test: 004 applies cleanly to a fresh DB and an existing DB; table, columns and indexes exist in `backend/tests/migrate.test.ts`.
- [x] T003 [P] Repository tests: createShare (normalisation, duplicate rejection), listSharesByRecipient, listSharesByOwner, getShareById, deleteShare, and cascade on user deletion in `backend/tests/db.test.ts`.
- [x] T004 Repository share functions in `backend/src/db/repository.ts`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The space resolver, space-aware file routes, new client types, server wiring, and e2e seed. Nothing user-visible yet.

- [x] T005 [P] Resolver tests: `space=own` maps to the user's bucket/prefix; `space=shared:<id>` maps to sharer bucket + prefix + folder; unknown/foreign/revoked share refused; malformed space refused; absent space defaults to own in `backend/tests/scope.test.ts`.
- [x] T006 Resolver (`SpaceRef` parse + `resolveSpace`) in `backend/src/scope.ts`.
- [x] T007 [P] Route tests: every `/api/files` operation accepts `space` (own default; shared listing, download, upload, delete, share-url against the sharer's scope; mount-relative keys; out-of-scope keys 400; revoked/foreign share 404) in `backend/tests/routes-files.test.ts`.
- [x] T008 Files routes consume the resolver; every operation takes `space` in `backend/src/routes/files.ts`.
- [x] T009 Verify the implemented API matches `contracts/openapi.yaml` v1.3.0 (space params, codes, schemas) in `.local/specs/006-folder-sharing/contracts/openapi.yaml`.
- [x] T010 [P] API client: space-aware `listFiles`, `getDownloadUrl`, `postUploadUrl`, `deleteFile`, `postShareUrl`; share/user types and functions; unit tests in `frontend/tests/api-client.test.ts` (extend the existing file).
- [x] T011 Seed a second non-admin user `bob` (prefix `users/bob/`, objects, fixed session cookie) in `backend/src/e2eServer.ts`.
- [x] T012 Mount `/api/shares` and `/api/users` with the files-family rate-limit middleware in `backend/src/server.ts`.

**Checkpoint**: Foundation ready - user story implementation can begin.

---

## Phase 3: User Story 1 - Share a folder with another user (Priority: P1) 🎯 MVP

**Goal**: Alice shares a subfolder with Bob via a searchable picker; the share persists and is visible to the owner.

**Independent Test**: Route tests create/list shares and assert validation; component tests drive the dialog; e2e shares `projects` with bob.

### Tests for User Story 1 ⚠️ write first, confirm failing before implementing

- [x] T013 [P] [US1] Create-share route tests: success (201, stored, owner + recipient), 400 for root folder, unsafe folder (`..`, absolute), unknown recipient, self-share; 409 duplicate (same owner/recipient/folder); responses match the contract codes in `backend/tests/routes-shares.test.ts`.
- [x] T014 [P] [US1] List-shares route tests: incoming (folderName, sharer identity) and outgoing (folderName, recipient identity, createdAt) shapes; empty lists; auth required in `backend/tests/routes-shares.test.ts`.
- [x] T015 [P] [US1] User-search route tests: case-insensitive substring, excludes caller, identity-only payload (never bucket/prefix/isAdmin), empty `q` returns nothing, cap at 20 in `backend/tests/routes-users.test.ts`.
- [x] T016 [P] [US1] ShareDialog component tests: recipient search renders matches and selects one, add succeeds and refreshes the recipient list, duplicate/self errors surface, revoke action present in `frontend/tests/ShareDialog.test.tsx`.

### Implementation for User Story 1

- [x] T017 [US1] Share routes (GET/POST `/api/shares`) in `backend/src/routes/shares.ts`.
- [x] T018 [US1] User search route (GET `/api/users`) in `backend/src/routes/users.ts`.
- [x] T019 [P] [US1] `ShareDialog` component (searchable picker, recipient list, revoke); folder share button; "Shared" chip on root rows with outgoing shares; received folders render no share button (no re-share, FR-015) in `frontend/src/components/ShareDialog.tsx`, `frontend/src/components/FileListing.tsx`.
- [x] T020 [US1] Wire the dialog into the folder rows: fetch shares, open per folder, refresh lists after add/revoke in `frontend/src/pages/Files.tsx`.

### E2E for User Story 1

- [x] T021 [US1] E2E: alice opens the share dialog on `projects`, searches `bo`, selects bob, confirms; dialog shows bob; the `projects` row shows the "Shared" indicator; `GET /api/shares` returns the outgoing share in `e2e/share-folder.spec.ts`.

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Recipient browses and downloads a shared folder (Priority: P1)

**Goal**: Bob sees the labelled mount at his root and reads the shared folder.

**Independent Test**: Route tests list/download in a shared space; e2e drives bob through mount, subfolder, download.

### Tests for User Story 2 ⚠️ write first, confirm failing before implementing

- [x] T022 [P] [US2] Route tests: shared-space listing (own prefix ignored; sharer's contents returned; empty folder OK), mount-relative download URL, key escaping the shared folder refused 400 in `backend/tests/routes-files.test.ts`.

### Implementation for User Story 2

- [x] T023 [US2] Space state in the browser page: mount rows at own root from `incoming` (labelled "Shared by \<username\>", rendered alongside same-named own folders), navigation into `space=shared:<id>` with mount-relative prefix, breadcrumbs starting at the mount name, share button absent for received folders in `frontend/src/pages/Files.tsx`, `frontend/src/components/FileListing.tsx`.

### E2E for User Story 2

- [x] T024 [US2] E2E: bob's root shows `projects` labelled "Shared by alice" (even when bob owns a folder of the same name); opening it lists the sharer's contents; subfolder navigation and a file download work in `e2e/share-folder.spec.ts`.

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Recipient uploads, overwrites, and deletes (Priority: P2)

**Goal**: Bob writes into the shared folder with the same rules as his own space.

**Independent Test**: Route tests presign/delete in a shared space; e2e uploads, conflicts, and deletes as bob.

### Tests for User Story 3 ⚠️ write first, confirm failing before implementing

- [x] T026 [P] [US3] Route tests: upload-url in a shared space (key lands under the sharer's prefix), overwrite conflict 409 then success, delete inside the shared folder, delete/upload escaping the shared folder refused 400 in `backend/tests/routes-files.test.ts`.

### Implementation for User Story 3

- [x] T027 [US3] Pass the space through upload (with overwrite confirmation) and delete flows in `frontend/src/components/UploadControl.tsx`, `frontend/src/components/DeleteDialog.tsx`, `frontend/src/pages/Files.tsx`.

### E2E for User Story 3

- [x] T028 [US3] E2E: bob uploads `notes.txt` into the shared folder (visible in alice's listing too), duplicate upload refused then replaced with overwrite consent, delete removes it from both views in `e2e/share-folder.spec.ts`.

**Checkpoint**: User Stories 1-3 work independently.

---

## Phase 6: User Story 4 - Owner revokes a share (Priority: P2)

**Goal**: Alice removes bob; his access stops at once.

**Independent Test**: Route tests revoke and re-resolve; e2e verifies mount disappearance and 404.

### Tests for User Story 4 ⚠️ write first, confirm failing before implementing

- [x] T029 [P] [US4] Route tests: owner revokes (204, row gone); non-owner and unknown id get 404; after revocation every `/api/files` operation in that space returns 404; re-sharing the same folder afterwards succeeds in `backend/tests/routes-shares.test.ts`.

### Implementation for User Story 4

- [x] T030 [US4] Revoke action in the dialog (`DELETE /api/shares/:id` via client), list refresh, error surfacing on a revoked/expired space (404 → refresh mounts and show an error) in `frontend/src/components/ShareDialog.tsx`, `frontend/src/api/client.ts`, `frontend/src/pages/Files.tsx`.

### E2E for User Story 4

- [x] T031 [US4] E2E: alice revokes bob's share; bob's next root load has no mount; a direct API call with the old share id returns 404 in `e2e/share-folder.spec.ts`.

**Checkpoint**: User Stories 1-4 work independently.

---

## Phase 7: User Story 5 - Account deletion cleans up shares (Priority: P3)

**Goal**: Deleting a user leaves no share traces.

**Independent Test**: Admin route tests delete a user and assert both share directions are gone.

### Tests for User Story 5 ⚠️ write first, confirm failing before implementing

- [x] T032 [P] [US5] Admin route tests: deleting a user removes their outgoing and incoming shares; the surviving user's shares and listings are unaffected; zero orphan rows in `backend/tests/routes-admin.test.ts`.

### Implementation for User Story 5

- [x] T033 [US5] FK enforcement is confirmed ON in `openDatabase` (`PRAGMA foreign_keys = ON`): assert the cascade alone removes shares on user deletion; no manual cleanup code in `backend/src/db/repository.ts`.

### E2E for User Story 5

- [x] T034 [US5] E2E: admin deletes bob; alice's root shows no mount and her share dialogs show no trace of bob in `e2e/share-folder.spec.ts` (or `e2e/admin.spec.ts`).

**Checkpoint**: All five user stories complete.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Constitution, docs, scripts, responsive verification, full suite.

- [x] T035 [P] Amend CLAUDE.md: scope the fire-and-forget clause to anonymous share links; state that user-to-user folder grants are stored, listed, and revocable in `CLAUDE.md`.
- [x] T036 [P] Update README feature list (folder sharing) and record quickstart validation results in `README.md`, `docs/quickstart-validation.md`.
- [x] T037 [P] curl validation script for the share API (create/list/revoke, search) against the e2e server in `scripts/verify-folder-share.sh`.
- [x] T038 [P] Exercise the share flows at mobile, tablet, and desktop viewports (no overflow, usable touch targets) in `e2e/share-folder.spec.ts`.
- [x] T039 Run the full suite: `bun run test`, `bun run test:e2e`, `bun run lint`, `bun run typecheck`, `bun run format:check` — all green, existing file-link share spec untouched and passing.
- [x] T040 Run quickstart.md end-to-end and record outcomes in `docs/quickstart-validation.md`.

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies; T001/T002/T003 run in parallel, T004 after T003.
- **Foundational (Phase 2)**: depends on Setup; T005/T006/T007/T008 in order, then T009/T010/T011/T012 (independent of each other). Blocks all user stories.
- **User Stories (Phase 3+)**: depend on Foundational; otherwise independent, runnable in priority order (US1 → US2 → US3 → US4 → US5).
- **Polish (final)**: depends on the targeted user stories being complete.

Within each story: tests written and failing → implementation → e2e. Tasks
touching the same file run sequentially (`Files.tsx` appears in T020/T023/
T027/T030; `routes-files.test.ts` in T007/T022/T026; `share-folder.spec.ts`
in T021/T024/T028/T031/T034/T038); `[P]` tasks on different files may run
together.

## Implementation Strategy

MVP first: Setup → Foundational → US1 (share creation) → US2 (read path) →
US3 (write path) → US4 (revocation) → US5 (cleanup) → Polish. Each story is
independently testable and leaves the suite green.
