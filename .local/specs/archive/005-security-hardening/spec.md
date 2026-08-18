# Feature Specification: Security Hardening

**Feature**: `005-security-hardening`
**Created**: 2026-08-18
**Status**: Draft

## Summary

A security review of the deployed JiveDrive (`drive.grimes.id.au`) found one
critical and several high/medium issues. This feature closes them:

- **Critical**: any account with zero discoverable passkeys is claimable by
  anyone who knows the username. `POST /auth/register/options {username}`
  returns registration options for unenrolled accounts, and the sign-in page's
  always-visible "First time? Use your username" form completes the ceremony.
  Live probe confirmed account `john` is currently in this state.
- **High**: the same endpoint enumerates the account inventory
  (`unknown_user` vs options vs `user_has_passkey`); no rate limiting exists
  anywhere (30/30 rapid requests returned 200).
- **Medium**: no security headers on any response; sessions are fixed 30-day
  TTL with no idle timeout and no revocation on passkey reset; S3 key scoping
  is a naive string-prefix check that accepts `..` segments; the Helm chart
  lacks container hardening (read-only rootfs, privilege escalation, caps,
  seccomp, resource limits).

The fix strategy: **enrollment is token-gated only** — the username-first
bootstrap flow is deleted; all first-passkey enrollment goes through an invite
token (new users) or the bootstrap enrollment token (the provisioned admin);
admin passkey reset issues a re-enrollment invite and revokes all sessions.
Plus rate limiting, security headers, session lifecycle, key-scope
normalisation, and chart hardening.

**Implementation target**: branch `004-passkey-login` (the deployed code).
`main` has diverged and must receive the same fixes when the branches are
reconciled (tracked as an Assumption, not a task).

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Token-gated first-passkey enrollment (Priority: P1)

A username alone can never claim an account. All first-passkey enrollment
requires a secret token: an invite token for new users, or the bootstrap
enrollment token for the provisioned admin account. The username-first
`register/options` / `register/verify` paths are removed. Claiming an invite
for a username that already exists (admin passkey reset) attaches the passkey
to that account instead of creating a duplicate.

**Why this priority**: This is the critical account-takeover fix (C1) plus the
enumeration fix (H1). It must ship before anything else.

**Independent Test**: Backend route tests drive `register/options` /
`register/verify` with tokens only; tests assert a username alone always
fails, a valid bootstrap token enrolls the provisioned admin, and an invite
whose username already exists attaches (never duplicates, never re-scopes).

**Acceptance Scenarios**:

1. **Given** an account with zero discoverable passkeys, **When** a caller
   POSTs `register/options` with only a username, **Then** the request is
   refused with a generic error and no registration options are returned.
2. **Given** the provisioned bootstrap admin and the configured enrollment
   token, **When** a caller POSTs `register/options` with that token,
   **Then** registration options are returned; completing the ceremony signs
   them in with admin rights.
3. **Given** the bootstrap admin now has one discoverable passkey, **When**
   the same token is used again, **Then** enrollment is refused (the
   zero-credentials gate blocks it).
4. **Given** an invite for a username that already exists with identical
   bucket/prefix/isAdmin and zero discoverable passkeys, **When** the invite
   is redeemed, **Then** the passkey is attached to the existing account and
   the invite is marked claimed.
5. **Given** an invite whose bucket, prefix, or isAdmin does not match the
   existing account of the same username, **When** it is redeemed, **Then**
   the claim is refused; the account is never re-scoped or re-privileged.
6. **Given** any request without a valid token, **When** it hits
   `register/options` or `register/verify`, **Then** the response does not
   reveal whether the username exists or how many passkeys it holds.
7. **Given** the frontend sign-in page, **When** rendered, **Then** it offers
   only "Sign in with passkey" and the invite-link registration path — no
   username input.

### User Story 2 - Admin passkey reset issues a re-enrollment invite and revokes sessions (Priority: P1)

The admin "reset passkeys" action no longer leaves an unclaimable-forever
window and no longer keeps sessions alive. It deletes the user's credentials,
revokes **all** of the user's sessions, and returns a fresh 48-hour
re-enrollment invite link for the user to redeem (US1 attach semantics).
Pending invites for that username are cancelled so exactly one live invite
exists.

**Why this priority**: Completes the C2 fix (revocation + no open claimable
window) and is the recovery path for locked-out users.

**Independent Test**: Backend route tests call `DELETE
/api/admin/users/{id}/passkeys` and assert: credentials deleted, every session
for that user gone (subsequent `validateSession` returns null), one pending
invite for the username exists, and the returned link redeems via the US1
flow. Frontend test asserts the reset dialog surfaces the link.

**Acceptance Scenarios**:

1. **Given** a signed-in admin and a target user, **When** the admin resets
   the target's passkeys, **Then** the target's credentials are deleted, all
   of the target's sessions are revoked immediately, and the response
   contains a new re-enrollment invite link for the target's username.
2. **Given** the target had a pending invite, **When** the reset runs,
   **Then** the old pending invite is cancelled (claimed invites are kept for
   audit).
3. **Given** an admin resets their own passkeys, **When** the action
   completes, **Then** the admin's own session is revoked too, and the
   response still returns the re-enrollment link (no dead end).
4. **Given** an unknown user id, **When** reset is attempted, **Then** 404,
   no invite created.

### User Story 3 - Rate limiting on auth and file APIs (Priority: P2)

The API rate-limits per client identity per route family (`/auth/*`,
`/api/files/*`), with a 429 + `Retry-After` on exceedance. Limits are
env-configurable and default to values that make enumeration and
presign-abuse impractical without disturbing legitimate use (single-user
personal drive).

**Why this priority**: Turns H2 (no rate limiting) into a bounded problem and
makes the US1 token brute-force impractical.

**Independent Test**: Backend unit tests exercise the bucket: burst, refill,
family separation, identity extraction with/without a trusted proxy, 429
body, and map cleanup. Route tests assert a 429 surfaces on sustained rapid
requests.

**Acceptance Scenarios**:

1. **Given** one client identity, **When** it exceeds the `/auth/*` limit
   within the window, **Then** subsequent requests return 429 with
   `{"error":…,"code":"rate_limited"}` and a `Retry-After` header; after the
   window the client is allowed again.
2. **Given** the same identity, **When** it hits `/api/files/*` and `/auth/*`
   concurrently, **Then** the two families are limited independently.
3. **Given** `JIVEDRIVE_TRUST_PROXY=true`, **When** a request carries
   `X-Forwarded-For`, **Then** the leftmost value is the identity; without the
   flag, **Then** the socket remote address is used and `X-Forwarded-For` is
   ignored (no spoofing bypass in development).
4. **Given** a 429 on `login/verify`, **Then** no challenge state is consumed
   or corrupted — the client re-runs `login/options` and retries.

### User Story 4 - Security headers on every response (Priority: P2)

Every HTTP response carries a hardened header set: CSP
(`default-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self'
data:`), `frame-ancestors 'none'` + `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`, and
`Cache-Control: no-store` on all `/api/*` and `/auth/*` responses. HSTS is
also set by the app in production.

**Why this priority**: M1 — no XSS blast-radius reduction, no clickjacking or
referrer-leak protection today (only the terminator's HSTS exists).

**Independent Test**: Backend tests assert the full header set on
representative responses: SPA page, JSON API success, JSON 4xx/401/404, and
the error handler's 500. A Playwright spec asserts the headers on a real page
load and that the SPA still renders and signs in under the CSP.

**Acceptance Scenarios**:

1. **Given** any response from the app, **When** inspected, **Then** it
   carries the full header set above.
2. **Given** an API or auth response, **When** inspected, **Then** it also
   carries `Cache-Control: no-store` (authenticated data is never cached).
3. **Given** the SPA under the new CSP, **When** loaded and used for a passkey
   ceremony, **Then** scripts, styles, and images all load and the ceremony
   completes (no CSP breakage).

### User Story 5 - Session lifecycle: idle timeout and cleanup (Priority: P3)

Sessions expire after 7 days of inactivity (rolling `lastUsedAt`), capped by
the existing absolute 30-day TTL. Expired sessions are purged lazily on
validation and in a sweep at startup. Passkey reset revokes all sessions
(US2).

**Why this priority**: M2 — a stolen cookie stays valid for 30 days today with
no inactivity bound; the sessions table also accumulates dead rows.

**Independent Test**: Backend tests cover idle expiry, absolute expiry,
rolling refresh on activity, the startup sweep, and
revoke-all-sessions-on-reset.

**Acceptance Scenarios**:

1. **Given** a session with activity within the idle window, **When**
   validated, **Then** it remains valid and its idle clock resets.
2. **Given** a session idle beyond the window (but inside the absolute TTL),
   **When** validated, **Then** it is invalid and deleted.
3. **Given** a session beyond the absolute TTL, **When** validated, **Then**
   it is invalid and deleted.
4. **Given** a database containing expired sessions at startup, **When** the
   server boots, **Then** they are purged.

### User Story 6 - S3 key-scope normalisation (Priority: P3)

Scope enforcement rejects `..` segments everywhere: prefix validation
(`normalizePrefix`, used by invites and bootstrap), relative-folder checks,
and the S3 key-scope assertion (`assertKeyInScope`) become segment-aware so no
key or prefix can ever contain a parent-traversal segment.

**Why this priority**: M3 — defense in depth. S3 keys are opaque today (no
actual escape), but the string-prefix check accepts `..` segments, which is
fragile and confusing.

**Independent Test**: Backend tests assert `..` segments are rejected by
invite creation, bootstrap prefix config, listing prefixes, and every
presign/head/delete call; valid scoping behaviour is unchanged.

**Acceptance Scenarios**:

1. **Given** an invite request with a prefix containing `..`, **When**
   created, **Then** 400 invalid_input.
2. **Given** a bootstrap config with a prefix containing `..`, **When**
   config loads, **Then** startup fails with a clear error.
3. **Given** a download/share/delete/upload request whose key contains a `..`
   segment, **When** processed, **Then** 400 out_of_scope (RangeError), never
   a signed URL.
4. **Given** valid keys and prefixes, **When** used, **Then** behaviour is
   unchanged (full regression suite green).

### User Story 7 - Deployment hardening (Priority: P3)

The Helm chart and container get hardened defaults: read-only root
filesystem (writable only on the `/data` PVC), `allowPrivilegeEscalation:
false`, `capabilities.drop: [ALL]`, seccomp `RuntimeDefault`, and sensible
default resource requests/limits. Chart docs cover the new env vars and the
re-enrollment link UX.

**Why this priority**: M4 — the pod currently runs with escalation and
capabilities permitted and no resource bounds.

**Independent Test**: `helm template` output is asserted (script or snapshot)
to contain the hardened `securityContext` and resource limits; the chart README
documents every new variable.

**Acceptance Scenarios**:

1. **Given** `helm template` of the chart, **When** inspected, **Then** the
   container has `readOnlyRootFilesystem: true` (with `/data` writable),
   `allowPrivilegeEscalation: false`, dropped capabilities, seccomp
   `RuntimeDefault`, and non-empty resource requests/limits.
2. **Given** a deployed pod, **When** started, **Then** it runs as the
   non-root `bun` user, boots, and the SQLite DB persists on the PVC (the
   `readOnlyRootFilesystem` does not break startup or writes).
3. **Given** the chart README, **When** read, **Then** it documents
   `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN`, the rate-limit vars, the
   session idle var, and the `JIVEDRIVE_TRUST_PROXY` flag with their defaults.

### Edge Cases

- **Bootstrap token reuse**: after the admin enrolls, the zero-credentials
  gate makes the token inert; rotation is a restart with a new env value.
- **Wrong bootstrap token**: response is the generic invite error — never a
  message that reveals a bootstrap token exists.
- **Reset with pending invite**: pending invites for the username are
  cancelled so exactly one live invite exists; claimed invites survive for
  audit.
- **Attach mismatch**: invite bucket/prefix/isAdmin differing from the
  existing account refuses the claim (no re-scope, no privilege change).
- **Rate-limit state**: in-memory and single-replica (Recreate strategy), so
  a restart resets buckets — acceptable; limits are advisory hardening, not a
  hard guarantee.
- **429 vs challenge state**: middleware runs before the route handler, so a
  429 never consumes a challenge or mutates state.
- **CSP vs daisyUI/Tailwind**: styles are external files; `style-src
  'unsafe-inline'` covers any inline style attributes so theming is
  unaffected. No inline scripts exist in the Vite build.
- **Read-only rootfs**: `/tmp`, `/data` (PVC) and any write paths the server
  needs must be verified — the app writes only to the SQLite DB on `/data`.
- **Legacy sessions**: migration backfills `lastUsedAt` from `createdAt`, so
  pre-existing sessions start with a full idle allowance.
- **e2e seeding**: `e2eServer.ts` seeds users with pre-set sessions; the
  auth/admin e2e specs that used the username fallback form switch to
  invite-based enrollment. Fixed session tokens (`browse-session` etc.) are
  test-only and remain acceptable because the server is not deployed.
- **Enumeration remainder**: token-validity is still distinguishable
  (invite-not-found vs expired vs claimed) — acceptable: tokens are 256-bit;
  usernames and passkey state are never revealed without a valid token.
- **`30d` share and other file behaviours**: untouched by this feature.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: First-passkey enrollment MUST require a valid secret token —
  an invite token or the configured bootstrap enrollment token. A username
  alone MUST NEVER yield registration options or a session. [US1]
- **FR-002**: The username-first `register/options` and `register/verify`
  request paths MUST be removed. [US1]
- **FR-003**: The bootstrap enrollment token MUST come from environment
  configuration (`JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN`), be required
  when a bootstrap admin username is configured, and be compared in
  constant time. [US1]
- **FR-004**: Redeeming an invite for a username that already exists MUST
  attach the passkey to that account only when bucket, prefix, and isAdmin
  match the existing account and it has zero discoverable passkeys;
  otherwise the claim MUST be refused without re-scoping or re-privileging.
  [US1]
- **FR-005**: Enrollment endpoints MUST NOT reveal account existence or
  passkey state except to a caller holding a valid token for that account.
  [US1]
- **FR-006**: `DELETE /api/admin/users/{id}/passkeys` MUST delete the user's
  credentials, revoke ALL of the user's sessions (including the caller's own
  when resetting self), cancel the user's pending invites, create a fresh
  48-hour re-enrollment invite, and return its link in the response. [US2]
- **FR-007**: Rate limiting MUST apply per client identity per route family
  (`/auth/*`, `/api/files/*`), return 429 + `Retry-After`, and be
  env-configurable with sane defaults. [US3]
- **FR-008**: Client identity MUST come from the leftmost `X-Forwarded-For`
  value only when `JIVEDRIVE_TRUST_PROXY=true`; otherwise from the socket
  remote address. [US3]
- **FR-009**: Every response MUST carry the header set: CSP
  (`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
  data:`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`. [US4]
- **FR-010**: `/api/*` and `/auth/*` responses MUST additionally carry
  `Cache-Control: no-store`. [US4]
- **FR-011**: Sessions MUST expire after 7 days of inactivity (rolling,
  env-configurable `JIVEDRIVE_SESSION_IDLE_DAYS`) and at the absolute 30-day
  TTL, whichever is sooner; expired sessions MUST be purged lazily and at
  startup. [US5]
- **FR-012**: Prefix and key validation MUST reject `..` segments at every
  scope boundary (invite creation, bootstrap config, listing, upload, share,
  download, delete). [US6]
- **FR-013**: The Helm chart MUST render a container securityContext with
  read-only rootfs (writable `/data`), `allowPrivilegeEscalation: false`,
  `capabilities.drop: [ALL]`, seccomp `RuntimeDefault`, and non-empty default
  resource requests/limits. [US7]

### Key Entities

- **User**: unchanged. `bucket`, `prefix`, `isAdmin` become the invariant
  that an attach claim must match.
- **PasskeyCredential**: unchanged. `discoverable` flag remains the
  enrollment gate (zero discoverable credentials required for any
  first-passkey claim).
- **Invite**: gains claim semantics — may target an existing user
  (attach) instead of only creating one. No schema change; the attach
  invariant is bucket/prefix/isAdmin equality. Pending invites for a username
  are cancelled on reset.
- **Session**: gains `lastUsedAt` (new column, backfilled from `createdAt`);
  validity = not absolute-expired AND not idle-expired.
- **Bootstrap enrollment token**: configuration, not data — env var,
  constant-time compared, inert once the account has a passkey.
- **Rate-limit state**: in-memory token buckets per (family, identity);
  not persisted.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: No request path exists where a username alone yields
  registration options or a session; a live probe equivalent to the review's
  (username-only `register/options`) returns a generic refusal.
- **SC-002**: `register/options` reveals nothing about account existence or
  passkey state without a valid token (identical response shape for
  unknown/existing/enrolled states given an invalid token).
- **SC-003**: Passkey reset revokes every session of the user in the same
  request and yields exactly one claimable re-enrollment invite link.
- **SC-004**: Sustained rapid requests from one identity against `/auth/*`
  produce a 429 with `Retry-After`; legitimate flows are unaffected at the
  default limits.
- **SC-005**: Every response (200, 4xx, 5xx, SPA, JSON) carries the FR-009
  header set; every API/auth response carries `Cache-Control: no-store`.
- **SC-006**: A session with no activity for the idle window is invalid;
  activity resets the clock; the absolute cap still holds.
- **SC-007**: All scope boundaries reject `..` segments; the full existing
  file-behaviour suite (list/download/upload/share/delete) stays green.
- **SC-008**: `helm template` renders the hardened securityContext and
  resource limits; a deployed pod boots with the DB on the PVC.
- **SC-009**: Backend unit, frontend vitest, and e2e Playwright suites are
  green after every user story (Constitution I).

## Assumptions

- Implementation targets branch `004-passkey-login` (what is deployed);
  `main` receives the same fixes during branch reconciliation (tracked
  separately, out of scope here).
- Operational actions from the review are **not** tasks here: (a) register a
  passkey for account `john` on the live deployment immediately; (b) verify
  the OVHcloud bucket is private with CORS restricted to the app origin;
  (c) stand up a PVC backup routine. Each is listed in the plan's constraints.
- The TLS terminator (Caddy or equivalent) keeps the HTTP→HTTPS redirect and
  HSTS; the app additionally sets HSTS in production so headers are complete
  regardless of terminator.
- No new runtime dependencies (Constitution II): rate limiting and headers
  are hand-rolled middleware.
- Single-replica deployment (helm `replicas: 1`, Recreate) makes in-memory
  rate-limit and challenge state correct.
- Default limits: `/auth/*` 20/min burst 10; `/api/files/*` 300/min burst
  100; `JIVEDRIVE_TRUST_PROXY=true` in the production chart config.
- Reset-created invites reuse the existing 48-hour invite lifetime (FR-003 in
  `admin.ts`); the bootstrap token has no expiry because the zero-credentials
  gate makes it single-use in effect.
- The frontend Register page (`/register?token=…`) serves both invite and
  bootstrap enrollment; no new page is needed.
