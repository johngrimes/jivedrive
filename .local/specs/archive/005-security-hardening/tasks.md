# Tasks: Security Hardening

**Input**: Design documents in `.local/specs/005-security-hardening/`
**Prerequisites**: plan.md (required), spec.md (required for user stories);
research.md, data-model.md, contracts/openapi.yaml present.

**Tests**: Test-driven development is mandatory. Every behaviour is covered by a
test task that precedes its implementation task, and those tests must be written
to fail first.

**Organisation**: Tasks are grouped by user story so each story can be
implemented and tested independently. Execution order: Foundational → US1
(enrollment gate) → US2 (reset + revocation) → US3 (rate limiting) → US4
(headers) → US5 (session lifecycle) → US6 (key scoping) → US7 (chart) →
Polish. US1 and US2 both depend on Foundational; US2 additionally uses US1's
attach semantics, so US1 lands first.

**Target branch**: `004-passkey-login` (the deployed code). All file paths are
relative to that branch's tree.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks).
- **[Story]**: the user story a task belongs to (US1, US2, ...); omitted for Setup, Foundational, and Polish.
- Every task includes an exact file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialisation and basic structure.

No setup tasks required: the feature adds zero dependencies, no new packages,
and reuses the existing workspace layout (`backend/`, `frontend/`, `e2e/`,
migration runner, test runners).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Migration, config surface, and repository plumbing that every
story builds on.

### Tests (write first, confirm failing)

- [x] T001 [P] Migration test: `003_session_last_used.sql` applies, adds
      `lastUsedAt`, backfills it from `createdAt` for existing rows in
      backend/tests/migrate.test.ts.
- [x] T002 [P] Config tests: `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN`
      required when a bootstrap username is set, rejected when too short
      (<16 chars); `JIVEDRIVE_SESSION_IDLE_DAYS`, rate-limit vars and
      `JIVEDRIVE_TRUST_PROXY` parse with defaults in
      backend/tests/config.test.ts.
- [x] T003 [P] Repository tests: session rows carry `lastUsedAt`
      (createSession sets it to createdAt; getSessionByToken returns it);
      `updateSessionLastUsed`; `deleteSessionsByUser` removes only that
      user's sessions in backend/tests/db.test.ts.

### Implementation

- [x] T004 [P] Write `backend/migrations/003_session_last_used.sql`
      (`ALTER TABLE sessions ADD COLUMN lastUsedAt TEXT;` + backfill UPDATE).
- [x] T005 [P] Extend `backend/src/config.ts` with the new env vars and
      validation (enrollment token required-with-username and ≥16 chars;
      idle days positive; rate-limit per-minute and burst positive; trust
      proxy boolean).
- [x] T006 [P] Extend `backend/src/db/repository.ts` with session
      `lastUsedAt` plumbing and `deleteSessionsByUser`.

**Checkpoint**: Foundation ready — migration 003, config surface, and session
repo helpers exist; unit tests green.

---

## Phase 3: User Story 1 - Token-gated first-passkey enrollment (Priority: P1) 🎯 MVP

**Goal**: A username alone can never claim an account; enrollment is
token-only (invite token or bootstrap enrollment token); invites attach to
existing zero-passkey users when scope/privilege match.

**Independent Test**: Route tests drive `register/options` + `register/verify`
with tokens only; username-only requests always fail generically; the
bootstrap token enrolls the provisioned admin; attach works and never
re-scopes.

### Tests for User Story 1 ⚠️ write first, confirm failing before implementing

- [x] T007 [P] [US1] `register/options` with only a username → 400 generic
      error, no options returned, for unknown and existing usernames in
      backend/tests/routes-auth.test.ts.
- [x] T008 [P] [US1] `register/verify` with only a username → 400, no
      credential created, no session in backend/tests/routes-auth.test.ts.
- [x] T009 [P] [US1] Bootstrap token: correct token → options with the
      admin's username/bucket/prefix; wrong token → generic invite error
      (never reveals a bootstrap token exists); token after the admin has a
      passkey → refused in backend/tests/routes-auth.test.ts.
- [x] T010 [P] [US1] Attach flow: invite whose username exists with matching
      bucket/prefix/isAdmin and zero discoverable passkeys → passkey attached
      to the existing user (no new user row), invite claimed, session set in
      backend/tests/routes-auth.test.ts.
- [x] T011 [P] [US1] Attach mismatch: invite bucket/prefix/isAdmin differs
      from the existing account → 400, no credential created, no re-scope in
      backend/tests/routes-auth.test.ts.
- [x] T012 [P] [US1] Attach when the account already has a discoverable
      passkey → refused (user_has_passkey) in
      backend/tests/routes-auth.test.ts.
- [x] T013 [P] [US1] Verify re-checks gates: a challenge obtained before the
      account gains a passkey is refused at verify in
      backend/tests/routes-auth.test.ts.
- [x] T014 [P] [US1] Enumeration: unknown, expired, and claimed tokens return
      identical response shapes (no account-existence or passkey-state
      disclosure) in backend/tests/routes-auth.test.ts.
- [x] T015 [P] [US1] Frontend client: `postRegisterOptions` /
      `postRegisterVerify` drop the username parameter in
      frontend/tests/api-client.test.ts.
- [x] T016 [P] [US1] SignIn page renders no username input and no
      "First time? Use your username" fallback; register link remains in
      frontend/tests/ (component test for SignIn).
- [x] T017 [P] [US1] E2E: first-passkey enrollment goes through an invite
      link (seeded invite), not the username form in e2e/auth.spec.ts and
      e2e/helpers.ts.

### Implementation for User Story 1

- [x] T018 [P] [US1] Rewrite `backend/src/routes/auth.ts`: remove the
      username branches of `register/options` and `register/verify`; add the
      bootstrap-token path (constant-time compare against config, gated on
      zero discoverable credentials); add the attach path (existing user,
      matching bucket/prefix/isAdmin, zero discoverable credentials →
      attach + claim); unify the options response to
      `{options, username, bucket, prefix}` for both token kinds.
- [x] T019 [P] [US1] Update `frontend/src/api/client.ts` signatures
      (`postRegisterOptions(token)`, `postRegisterVerify({token, credential})`;
      RegisterOptionsResponse now always carries bucket/prefix).
- [x] T020 [P] [US1] Update `frontend/src/pages/SignIn.tsx`: delete the
      fallback username form and its state; keep the passkey button and the
      invite-link registration path.
- [x] T021 [P] [US1] Update `frontend/src/pages/Register.tsx` copy for
      token-only enrollment (bootstrap token uses the same page).
- [x] T022 [US1] Update `backend/src/e2eServer.ts` to seed a usable invite
      for the e2e enrollment flow; update e2e helpers to enroll via invite
      token in e2e/helpers.ts.

**Checkpoint**: User Story 1 fully functional — username-only probes fail
generically; bootstrap + invite enrollment work; attach is safe; frontend and
e2e updated.

---

## Phase 4: User Story 2 - Admin passkey reset issues re-enrollment invite and revokes sessions (Priority: P1)

**Goal**: Reset deletes credentials, revokes ALL sessions, cancels pending
invites, and returns a fresh 48h re-enrollment link.

**Independent Test**: Route tests call `DELETE /api/admin/users/{id}/passkeys`
and assert credential deletion, session revocation (including self),
pending-invite cancellation, one new pending invite, and a redeemable link.

### Tests for User Story 2 ⚠️ write first, confirm failing before implementing

- [x] T023 [P] [US2] Reset deletes the user's credentials, revokes ALL of the
      user's sessions (subsequent validateSession returns null), cancels
      pending invites for the username, and returns `{invite, link}` (200)
      in backend/tests/routes-admin.test.ts.
- [x] T024 [P] [US2] Reset self revokes the caller's own session and still
      returns the link in backend/tests/routes-admin.test.ts.
- [x] T025 [P] [US2] Unknown user id → 404, no invite created, no credentials
      touched in backend/tests/routes-admin.test.ts.
- [x] T026 [P] [US2] Reset of the last admin is allowed (user row kept,
      admin count unchanged) in backend/tests/routes-admin.test.ts.
- [x] T027 [P] [US2] Other users' sessions are untouched by a reset in
      backend/tests/routes-admin.test.ts.
- [x] T028 [P] [US2] Frontend: admin reset flow shows the returned
      re-enrollment link (copyable), mirroring invite creation, in
      frontend/src/pages/AdminUsers.tsx tests; api client reset response type
      updated in frontend/tests/api-client.test.ts.

### Implementation for User Story 2

- [x] T029 [P] [US2] Rewrite the reset handler in
      `backend/src/routes/admin.ts`: delete credentials, delete all sessions
      (`deleteSessionsByUser`), cancel pending invites for the username
      (new repository helper `cancelPendingInvitesByUsername`), create a
      fresh 48h invite with the user's bucket/prefix/isAdmin, return
      `{invite, link}`.
- [x] T030 [P] [US2] Add `cancelPendingInvitesByUsername` to
      `backend/src/db/repository.ts` (claimed invites survive).
- [x] T031 [US2] Update `frontend/src/pages/AdminUsers.tsx` reset flow to
      surface and copy the re-enrollment link.

**Checkpoint**: User Story 2 works — reset is fully revoking and yields a
single redeemable re-enrollment invite.

---

## Phase 5: User Story 3 - Rate limiting on auth and file APIs (Priority: P2)

**Goal**: Token-bucket rate limiting per client identity per route family,
429 + Retry-After, env-configurable, no new dependency.

**Independent Test**: Unit tests exercise the bucket (burst, refill, family
separation, identity extraction, pruning); route tests assert 429s surface.

### Tests for User Story 3 ⚠️ write first, confirm failing before implementing

- [x] T032 [P] [US3] Bucket unit tests: burst allows `capacity` requests,
      then 429s; tokens refill over time; per-minute rate governs refill in
      backend/tests/ (new rateLimit test file, e.g. backend/tests/rateLimit.test.ts).
- [x] T033 [P] [US3] Family separation: `/auth/*` exhaustion does not affect
      `/api/files/*` in backend/tests/rateLimit.test.ts.
- [x] T034 [P] [US3] Identity extraction: `X-Forwarded-For` leftmost used when
      trust-proxy on; socket address used and XFF ignored when off
      (no spoof bypass) in backend/tests/rateLimit.test.ts.
- [x] T035 [P] [US3] 429 response carries `{"error":…,"code":"rate_limited"}`
      and a `Retry-After` header in backend/tests/routes-auth.test.ts.
- [x] T036 [P] [US3] Map pruning and size cap keep memory bounded in
      backend/tests/rateLimit.test.ts.
- [x] T037 [P] [US3] A 429 on `login/options`/`login/verify` consumes no
      challenge state (next options works) in backend/tests/routes-auth.test.ts.

### Implementation for User Story 3

- [x] T038 [P] [US3] Implement `backend/src/security/rateLimit.ts`:
      token-bucket store keyed by (family, identity) with lazy pruning and a
      size cap; `createRateLimitMiddleware(config, family)` returning a Hono
      middleware; identity from leftmost `X-Forwarded-For` when
      `JIVEDRIVE_TRUST_PROXY=true`, else `server.requestIP`.
- [x] T039 [P] [US3] Wire the middleware in `backend/src/server.ts` for the
      `/auth/*` and `/api/files/*` route groups (healthcheck and static
      excluded).

**Checkpoint**: User Story 3 works — rapid requests 429 with Retry-After;
legitimate single-user use is unaffected at defaults.

---

## Phase 6: User Story 4 - Security headers on every response (Priority: P2)

**Goal**: Every response carries the hardened header set; API/auth responses
are `no-store`.

**Independent Test**: Route tests assert the full header set on SPA, JSON 200,
4xx, and 500 responses; e2e asserts the SPA still works under CSP.

### Tests for User Story 4 ⚠️ write first, confirm failing before implementing

- [x] T040 [P] [US4] Header tests: CSP (`default-src 'self'; style-src 'self'
      'unsafe-inline'; img-src 'self' data:`), `frame-ancestors 'none'`,
      `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: same-origin`,
      `Permissions-Policy: camera=(), microphone=(), geolocation=()` present
      on SPA page, JSON 200, 401/404, and the error handler's 500 in
      backend/tests/server.test.ts.
- [x] T041 [P] [US4] `Cache-Control: no-store` on `/api/*` and `/auth/*`
      responses in backend/tests/server.test.ts.
- [x] T042 [P] [US4] HSTS sent only when NODE_ENV=production in
      backend/tests/server.test.ts.
- [x] T043 [P] [US4] E2E: page load carries the headers and the passkey
      ceremony still completes under CSP in e2e/auth.spec.ts.

### Implementation for User Story 4

- [x] T044 [P] [US4] Implement `backend/src/security/headers.ts` middleware
      (full header set; `no-store` on `/api/*` and `/auth/*`; HSTS in
      production).
- [x] T045 [P] [US4] Wire the header middleware in `backend/src/server.ts`
      ahead of all routes.

**Checkpoint**: User Story 4 works — every response hardened; SPA and
ceremony unaffected under CSP.

---

## Phase 7: User Story 5 - Session lifecycle: idle timeout and cleanup (Priority: P3)

**Goal**: Sessions expire after idle window (rolling) and at the absolute
TTL; expired rows purged lazily and at startup.

**Independent Test**: Backend tests inject `now` and cover idle expiry,
absolute expiry, rolling refresh, and the startup sweep.

### Tests for User Story 5 ⚠️ write first, confirm failing before implementing

- [x] T046 [P] [US5] Idle expiry: session with no activity past
      `JIVEDRIVE_SESSION_IDLE_DAYS` is invalid and deleted in
      backend/tests/sessions.test.ts.
- [x] T047 [P] [US5] Rolling refresh: activity within the window keeps the
      session valid and resets `lastUsedAt` in backend/tests/sessions.test.ts.
- [x] T048 [P] [US5] Absolute TTL still caps the session in
      backend/tests/sessions.test.ts.
- [x] T049 [P] [US5] Startup sweep purges absolute- and idle-expired sessions
      in backend/tests/sessions.test.ts (or server.test.ts).
- [x] T050 [P] [US5] `/auth/me` and protected routes reflect idle expiry
      (validateSession path) in backend/tests/routes-auth.test.ts.

### Implementation for User Story 5

- [x] T051 [P] [US5] Extend `backend/src/auth/sessions.ts`:
      `validateSession` enforces idle expiry and touches `lastUsedAt`;
      `createSession` writes `lastUsedAt = createdAt`.
- [x] T052 [P] [US5] Add the startup sweep in `backend/src/server.ts` `main()`
      (delete absolute- and idle-expired sessions after migrate).

**Checkpoint**: User Story 5 works — idle + absolute expiry, rolling clock,
startup purge.

---

## Phase 8: User Story 6 - S3 key-scope normalisation (Priority: P3)

**Goal**: `..` segments rejected at every scope boundary; valid scoping
unchanged.

**Independent Test**: Backend tests assert `..` rejection in prefix
validation, config load, listing, and every presign/head/delete call.

### Tests for User Story 6 ⚠️ write first, confirm failing before implementing

- [x] T053 [P] [US6] `normalizePrefix` rejects `..` segments (invite
      creation and bootstrap config paths) in backend/tests/db.test.ts and
      backend/tests/config.test.ts.
- [x] T054 [P] [US6] `assertKeyInScope` rejects keys containing `..` segments
      (RangeError) for presign GET/PUT, head, and delete in
      backend/tests/s3.test.ts and backend/tests/routes-files.test.ts.
- [x] T055 [P] [US6] Listing/upload folder prefix with `..` → 400 (regression
      of isSafeRelativePrefix) in backend/tests/routes-files.test.ts.
- [x] T056 [P] [US6] Valid keys and prefixes behave unchanged (regression:
      full file-route suite) in backend/tests/routes-files.test.ts.

### Implementation for User Story 6

- [x] T057 [P] [US6] Reject `..` segments in `normalizePrefix`
      (`backend/src/db/repository.ts`) and make `assertKeyInScope`
      segment-aware (`backend/src/s3/client.ts`).

**Checkpoint**: User Story 6 works — parent-traversal segments impossible at
every boundary.

---

## Phase 9: User Story 7 - Deployment hardening (Priority: P3)

**Goal**: Helm chart renders hardened securityContext + resource limits;
docs cover the new env vars and reset UX.

**Independent Test**: `helm template` assertions via a verification script
run in CI; deployment smoke test on the minikube cluster.

### Tests for User Story 7 ⚠️ write first, confirm failing before implementing

- [x] T058 [P] [US7] Helm verification script asserts `helm template` output
      contains `readOnlyRootFilesystem: true` (with `/data` writable),
      `allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`,
      seccomp `RuntimeDefault`, non-empty requests/limits in
      scripts/verify-helm-hardening.sh.
- [x] T059 [P] [US7] Deploy job runs the verification before
      `helm upgrade` in .github/workflows/quality-and-deploy.yml.

### Implementation for User Story 7

- [x] T060 [P] [US7] Harden `deploy/helm/jivedrive/templates/deployment.yaml`
      (container securityContext + resources wired from values).
- [x] T061 [P] [US7] Add default resources and the new env vars to
      `deploy/helm/jivedrive/values.yaml` and `values-ci.yaml`
      (`JIVEDRIVE_TRUST_PROXY: "true"`, rate-limit defaults, idle days;
      bootstrap token documented as secretConfig-style override).
- [x] T062 [P] [US7] Document new vars, reset link UX, and hardened defaults
      in `deploy/helm/jivedrive/README.md`.

**Checkpoint**: User Story 7 works — chart renders hardened, docs complete.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Contract/doc consistency, verification-script updates, full-suite
validation.

- [x] T063 [P] Update `scripts/verify-admin.sh` (and other verify scripts if
      affected) for the reset endpoint's new 200 `{invite, link}` response
      and token-only enrollment.
- [x] T064 [P] Update `docs/quickstart-validation.md` for the new enrollment
      and reset flows.
- [x] T065 [P] Update the CLAUDE.md Security Requirements section:
      "First-passkey enrollment is token-gated (invite or bootstrap
      enrollment token); a username alone never grants enrollment."
- [x] T066 Final consistency pass over spec.md, plan.md, data-model.md,
      contracts/openapi.yaml and this tasks file (no contradictions; every
      FR mapped).
- [x] T067 Run the full suite: `bun run test`, `bun run typecheck`,
      `bun run lint`, `bun run format:check`, `bun run test:e2e` — all green.
- [x] T068 Run `scripts/verify-helm-hardening.sh` and the quickstart
      scenarios (headers, 429, username-only refusal) against a local
      e2eServer run.

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: none required.
- **Foundational (Phase 2)**: T001–T006 — blocks all user stories (migration,
  config, repo plumbing).
- **US1 (T007–T022)**: depends on Foundational; blocks US2 (attach semantics).
- **US2 (T023–T031)**: depends on US1 and Foundational.
- **US3 (T032–T039)**: depends on Foundational; independent of US1/US2.
- **US4 (T040–T045)**: depends on Foundational; independent.
- **US5 (T046–T052)**: depends on Foundational (migration T001, repo T003).
- **US6 (T053–T057)**: depends on Foundational; independent.
- **US7 (T058–T062)**: depends on nothing in this feature; independent.
- **Polish (T063–T068)**: after the targeted stories; T067/T068 require all
  stories complete.

Within each story: tests written and confirmed failing → implementation →
checkpoint. `[P]` tasks on different files may run together; tasks touching
the same file run sequentially (e.g. T018 before T022; T007–T014 all touch
backend/tests/routes-auth.test.ts — run sequentially within that file set).

## Implementation Strategy

MVP first: Foundational → US1 (closes the critical takeover) → US2 (reset
revocation) → US3/US4 (high/medium API hardening) → US5/US6/US7 (lifecycle,
scoping, deployment) → Polish. Each story is independently testable and
deployable after US1.
