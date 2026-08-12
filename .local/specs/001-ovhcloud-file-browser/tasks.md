# Tasks: JiveDrive

**Input**: Design documents in `.local/specs/001-ovhcloud-file-browser/`
**Prerequisites**: plan.md (required), spec.md (required for user stories);
research.md, data-model.md, contracts/openapi.yaml present.

**Tests**: Test-driven development is mandatory. Every behaviour is covered by
a test task that precedes its implementation task, and those tests must be
written to fail first.

**Organisation**: Tasks are grouped by user story so each story can be
implemented and tested independently.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks).
- **[Story]**: the user story a task belongs to (US1, US2, ...); omitted for Setup, Foundational, and Polish.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialisation and basic structure.

- [ ] T001 Initialise git repo and bun workspace root with `backend` and `frontend` workspaces in `package.json`.
- [ ] T002 Configure TypeScript strict for root, backend, and frontend in `tsconfig.json`, `backend/tsconfig.json`, `frontend/tsconfig.json`.
- [ ] T003 Configure ESLint and Prettier per the static-analysis reference in `eslint.config.js` and `.prettierrc`.
- [ ] T004 Configure Vitest for backend and frontend in `backend/vitest.config.ts` and `frontend/vitest.config.ts`.
- [ ] T005 Configure Playwright with webServer task in `e2e/playwright.config.ts`.
- [ ] T006 Write multi-stage Dockerfile that builds the SPA and bundles the backend in `docker/Dockerfile` and `.dockerignore`.

**Checkpoint**: Workspace builds, lints, and both test runners execute.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST complete before any user story begins.

- [ ] T007 [P] Write config module tests (env parsing, defaults, validation errors) in `backend/tests/config.test.ts`.
- [ ] T008 [P] Implement config module reading validated environment variables in `backend/src/config.ts`.
- [ ] T009 [P] Write migration runner tests (applies in order, idempotent) in `backend/tests/migrate.test.ts`.
- [ ] T010 [P] Write initial schema migration `001_init.sql` (users, passkey_credentials, invites, sessions) in `backend/migrations/001_init.sql`.
- [ ] T011 [P] Implement migration runner applied at startup in `backend/src/db/migrate.ts`.
- [ ] T012 [P] Write data-layer tests for users, credentials, invites, sessions against in-memory SQLite in `backend/tests/db.test.ts`.
- [ ] T013 [P] Implement typed data layer per `data-model.md` in `backend/src/db/repository.ts`.
- [ ] T014 [P] Write S3 wrapper tests (list, head, delete, presigned GET/PUT) against a stub client in `backend/tests/s3.test.ts`.
- [ ] T015 [P] Implement S3 client wrapper with OVHcloud endpoint config and scoped key validation in `backend/src/s3/client.ts`.
- [ ] T016 [P] Write session helper tests (create, validate, destroy, expiry) in `backend/tests/sessions.test.ts`.
- [ ] T017 [P] Implement opaque session cookie helpers in `backend/src/auth/sessions.ts`.
- [ ] T018 [P] Write server scaffold tests (healthcheck, static SPA serving, 404) in `backend/tests/server.test.ts`.
- [ ] T019 [P] Implement Hono server entry with `/healthcheck`, middleware wiring, and SPA static serving in `backend/src/server.ts`.
- [ ] T020 [P] Scaffold Vite React SPA with router and API client in `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/api/client.ts`.

**Checkpoint**: Foundation ready - user story implementation can begin.

---

## Phase 3: User Story 1 - Passkey sign-in and invite registration (Priority: P1) 🎯 MVP

**Goal**: A user signs in with a passkey; an invitee registers their passkey
via an invite link and is signed in.

**Independent Test**: With a seeded user, sign in and sign out work. With a
valid unexpired invite, an invitee registers and signs in. Expired or claimed
invites are refused.

### Tests for User Story 1 ⚠️ write first, confirm failing before implementing

- [ ] T021 [P] [US1] Write WebAuthn registration flow tests (options, verify, challenge expiry, credential storage) in `backend/tests/webauthn.test.ts`.
- [ ] T022 [P] [US1] Write WebAuthn login flow tests (assertion verify, counter update, unknown user) in `backend/tests/webauthn.test.ts`.
- [ ] T023 [P] [US1] Write auth route tests (register options/verify, login options/verify, logout, me; expired/claimed invite rejection; session cookie set/cleared) in `backend/tests/routes-auth.test.ts`.
- [ ] T024 [P] [US1] Write bootstrap admin seeding tests in `backend/tests/bootstrap.test.ts`.
- [ ] T025 [P] [US1] Write Playwright test for sign-in with a seeded passkey and sign-out in `e2e/auth.spec.ts`.

### Implementation for User Story 1

- [ ] T026 [P] [US1] Implement WebAuthn service wrapping simplewebauthn (registration and assertion options, verification, credential persistence) in `backend/src/auth/webauthn.ts`.
- [ ] T027 [P] [US1] Implement auth routes per `contracts/openapi.yaml` in `backend/src/routes/auth.ts`.
- [ ] T028 [US1] Implement bootstrap admin provisioning from config in `backend/src/db/bootstrap.ts`.
- [ ] T029 [US1] Implement SignIn page with username entry and passkey prompt in `frontend/src/pages/SignIn.tsx`.
- [ ] T030 [US1] Implement Register page that claims an invite token and creates the passkey in `frontend/src/pages/Register.tsx`.

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 - Browse and download files (Priority: P1)

**Goal**: A signed-in user navigates folders in their own space, loads more
pages, and downloads files.

**Independent Test**: With a bucket containing known objects across prefixes,
listing separates folders and files, pagination works, and downloads return
the file bytes. Keys outside the user's prefix are rejected.

### Tests for User Story 2 ⚠️ write first, confirm failing before implementing

- [ ] T031 [P] [US2] Write listing route tests (folders vs files, size/name mapping, cursor pagination, empty state, scope enforcement 400) in `backend/tests/routes-files.test.ts`.
- [ ] T032 [P] [US2] Write download URL route tests (presigned GET, scope enforcement) in `backend/tests/routes-files.test.ts`.
- [ ] T033 [P] [US2] Write Playwright test for browse, folder navigation, load more, and download in `e2e/browse.spec.ts`.

### Implementation for User Story 2

- [ ] T034 [P] [US2] Implement files routes (list, download-url) per `contracts/openapi.yaml` in `backend/src/routes/files.ts`.
- [ ] T035 [US2] Implement Files page with breadcrumbs, folder/file listing, load more, and download action in `frontend/src/pages/Files.tsx`.
- [ ] T036 [US2] Implement listing components (table rows, breadcrumbs, empty state, loading skeletons) in `frontend/src/components/FileListing.tsx`.

**Checkpoint**: User Story 2 fully functional and independently testable.

---

## Phase 5: User Story 3 - Upload files (Priority: P2)

**Goal**: A signed-in user uploads a single file into the viewed folder with
progress feedback and overwrite confirmation.

**Independent Test**: Uploading a new file shows progress and adds it to the
listing; uploading over an existing name is refused until confirmed; failed
uploads surface an error.

### Tests for User Story 3 ⚠️ write first, confirm failing before implementing

- [ ] T037 [P] [US3] Write upload URL route tests (presigned PUT, 409 without overwrite flag, key scoping, file name encoding) in `backend/tests/routes-files.test.ts`.
- [ ] T038 [P] [US3] Write Playwright test for upload, overwrite confirmation, and error display in `e2e/upload.spec.ts`.

### Implementation for User Story 3

- [ ] T039 [P] [US3] Implement upload URL route per `contracts/openapi.yaml` in `backend/src/routes/files.ts`.
- [ ] T040 [US3] Implement upload control with progress, success/failure feedback, and overwrite confirm dialog in `frontend/src/components/UploadControl.tsx`.

**Checkpoint**: User Stories 1-3 work independently.

---

## Phase 6: User Story 4 - Share links (Priority: P2)

**Goal**: A signed-in user generates a presigned share link with a default
7-day expiry and per-link overrides; links are never stored.

**Independent Test**: Generated links download the file without a session,
reflect the chosen expiry, and are refused by the provider after expiry.

### Tests for User Story 4 ⚠️ write first, confirm failing before implementing

- [ ] T041 [P] [US4] Write share URL route tests (default 7d, enum overrides, expiry parameter in URL, scope enforcement, nothing persisted) in `backend/tests/routes-files.test.ts`.
- [ ] T042 [P] [US4] Write Playwright test for share link generation, expiry selection, copy, and anonymous download in `e2e/share.spec.ts`.

### Implementation for User Story 4

- [ ] T043 [P] [US4] Implement share URL route per `contracts/openapi.yaml` in `backend/src/routes/files.ts`.
- [ ] T044 [US4] Implement ShareModal with expiry select, generated link display, and copy button in `frontend/src/components/ShareModal.tsx`.

**Checkpoint**: User Stories 1-4 work independently.

---

## Phase 7: User Story 5 - Delete files (Priority: P3)

**Goal**: A signed-in user permanently deletes an object after confirming.

**Independent Test**: Deleting removes the object from the listing; download
and share of that key then fail; cancelling the prompt leaves it intact.

### Tests for User Story 5 ⚠️ write first, confirm failing before implementing

- [ ] T045 [P] [US5] Write delete route tests (204, 404 for missing object, scope enforcement 400) in `backend/tests/routes-files.test.ts`.
- [ ] T046 [P] [US5] Write Playwright test for delete with confirm and cancel in `e2e/delete.spec.ts`.

### Implementation for User Story 5

- [ ] T047 [P] [US5] Implement delete route per `contracts/openapi.yaml` in `backend/src/routes/files.ts`.
- [ ] T048 [US5] Implement delete confirmation dialog in `frontend/src/components/DeleteDialog.tsx`.

**Checkpoint**: User Stories 1-5 work independently.

---

## Phase 8: User Story 6 - Admin user management (Priority: P3)

**Goal**: An admin invites users with bucket/prefix/role, lists users and
invites, re-sends and cancels invites, and removes users without touching
storage objects.

**Independent Test**: Invite creation shows a 48-hour link; the invitee
registers; the admin removes the user; sign-in then fails and objects remain.

### Tests for User Story 6 ⚠️ write first, confirm failing before implementing

- [ ] T049 [P] [US6] Write admin route tests (create/resend/cancel/list invites, expiry status, list/remove users, last-admin protection, non-admin 403) in `backend/tests/routes-admin.test.ts`.
- [ ] T050 [P] [US6] Write Playwright test for the admin invite and removal flow in `e2e/admin.spec.ts`.

### Implementation for User Story 6

- [ ] T051 [P] [US6] Implement admin routes per `contracts/openapi.yaml` in `backend/src/routes/admin.ts`.
- [ ] T052 [US6] Implement AdminUsers page (invite form, pending invites table, users table) in `frontend/src/pages/AdminUsers.tsx`.

**Checkpoint**: All user stories work independently.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Deployment packaging, documentation, and final validation.

- [ ] T053 Write Helm chart skeleton (Chart.yaml, values.yaml, README) per helm-charts skill in `deploy/helm/jivedrive/`.
- [ ] T054 Write chart templates: deployment (probes, Recreate, env from config/secretConfig), service, pvc, configmap in `deploy/helm/jivedrive/templates/`.
- [ ] T055 Validate chart with `helm lint` and `helm template` using default and custom values.
- [ ] T056 Write root README covering local dev, configuration, deployment, and passkey setup in `README.md`.
- [ ] T057 [P] Run quickstart.md scenarios end-to-end and record results in `docs/quickstart-validation.md`.
- [ ] T058 Final full pass: bun test, lint, typecheck, and Playwright suite all green.

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; blocks all user stories.
- **User Stories (Phase 3+)**: depend on Foundational; otherwise independent, runnable in priority order (P1 → P2 → P3) or parallel. Note US2 (T031-T036) has no dependency on US1 implementation files, but the Files page is only reachable after sign-in, so US1 e2e must pass before US2 e2e is meaningful.
- **Polish (final)**: depends on the targeted user stories being complete (chart and README need the real deployment shape; quickstart validation needs all stories).

Within each story: tests written and failing → models → services → endpoints →
integration. Tasks touching the same file run sequentially; `[P]` tasks on
different files may run together. `backend/tests/routes-files.test.ts` is
shared by US2-US5 tasks T031/T032, T037, T041, T045 - those run sequentially
within that file.

## Implementation Strategy

MVP first: Setup → Foundational → User Story 1 (auth) → User Story 2 (browse),
then validate independently before adding upload, share, delete, and admin
stories incrementally. Deploy packaging and validation land in Polish.
