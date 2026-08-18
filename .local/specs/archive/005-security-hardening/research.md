# Research: Security Hardening

**Feature**: `005-security-hardening` | **Date**: 2026-08-18 | **Spec**: [spec.md](spec.md)

One decision/rationale/alternatives entry per resolved technical question.

## R1: How to gate first-passkey enrollment

- **Decision**: Delete the username-first `register/options`/`register/verify`
  paths entirely. Enrollment is token-only: invite tokens (new users) and the
  bootstrap enrollment token (provisioned admin, env-config). Invite claims
  attach to an existing zero-passkey user when bucket/prefix/isAdmin match.
- **Rationale**: One token system instead of two; no code path where a
  username alone yields options; the attach invariant prevents re-scoping and
  re-privileging; the zero-credentials gate makes any token inert once the
  account is enrolled, so bootstrap tokens need no expiry and no
  chicken-and-egg recovery.
- **Alternatives considered**:
  - Separate enrollment-token field beside the username: two token systems,
    a UI token field, and the username path still exists to get wrong.
  - Time-window-only gate (enroll within N minutes of provisioning): no
    token machinery, but enumeration persists inside the window and an
    attacker can still race the legitimate user; rejected.
  - Bootstrap as a DB invite row (48h): unified path, but an expired
    bootstrap invite cannot be re-issued without a signed-in admin —
    rejected for the chicken-and-egg.

## R2: Where the bootstrap enrollment token lives

- **Decision**: Env var `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN`, required
  when `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` is set (mirrors the existing
  bucket-required rule in `config.ts`); constant-time compare; validated at
  `register/options` and re-checked at `register/verify` (the zero-credentials
  gate is the second check).
- **Rationale**: Operator-controlled (no log scraping), rotatable by restart,
  no expiry problem (gate makes it single-use in effect), no schema change.
  Matches the existing "secrets from environment configuration, never from the
  repository" constitution rule.
- **Alternatives considered**:
  - Auto-generate at provisioning and print once to stdout: tokens in logs,
    lost-log recovery problem — rejected.
  - DB invite row with long TTL: special-case expiry handling — rejected (R1).

## R3: Rate-limiting mechanism and placement

- **Decision**: Hand-rolled token-bucket Hono middleware in `src/security/`,
  no new dependency. Two families (`/auth/*`, `/api/files/*`) keyed by
  `(family, identity)`. Identity = leftmost `X-Forwarded-For` when
  `JIVEDRIVE_TRUST_PROXY=true`, else `Bun.serve` `server.requestIP` remote
  address. 429 + `Retry-After` + JSON `{error, code: "rate_limited"}`. Buckets
  are a `Map` with lazy pruning and a size cap.
- **Rationale**: Constitution II (no dependencies without justification);
  single-replica + Recreate makes in-memory state correct; testable in unit
  and route tests; env-configurable limits keep the personal-drive defaults
  non-intrusive. Caddy sets `X-Forwarded-For` and is the only entry point in
  prod, so trusting it behind the flag is sound.
- **Alternatives considered**:
  - `@hono/rate-limiter`: battle-tested, but a new dependency for ~50 lines —
    rejected per Constitution II.
  - Terminator-level limits (Caddy): config outside the repo, untestable in
    CI, bypassed by direct access — rejected.

## R4: Session lifecycle model

- **Decision**: Add `sessions.lastUsedAt` (migration 003, backfilled from
  `createdAt`); `validateSession` returns validity = not absolute-expired AND
  `now - lastUsedAt < idleDays`; on valid validation, touch `lastUsedAt`
  (rolling window); idle default 7 days via `JIVEDRIVE_SESSION_IDLE_DAYS`;
  startup sweep deletes absolute- and idle-expired sessions; passkey reset
  deletes all sessions for the user.
- **Rationale**: Rolling idle timeout with an absolute cap is the standard
  balance for a personal drive; touch-on-validate is one indexed UPDATE per
  request (negligible at this scale); startup sweep bounds table growth.
- **Alternatives considered**:
  - Fixed TTL only (status quo): 30-day stolen-cookie window, dead rows
    accumulate — rejected.
  - Idle-only, no absolute cap: sessions could live forever with sparse
    activity — rejected.

## R5: Security headers placement

- **Decision**: In-app middleware (`src/security/headers.ts`) applied to every
  response, so the header set is repo-owned, tested, and terminator-independent.
  HSTS set in-app only when `NODE_ENV=production` (the terminator already
  sends it; the app-level copy keeps headers complete).
- **Rationale**: The terminator config is not in this repository; app-level
  headers are CI-testable and ship with the feature (Constitution: deployment
  artifacts ship with every feature).
- **Alternatives considered**: terminator-only (untestable, out of repo —
  rejected).

## R6: CSP strictness vs daisyUI/Tailwind

- **Decision**: `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'`.
  `'unsafe-inline'` restricted to styles only.
- **Rationale**: The Vite build emits only external scripts (no inline
  scripts), so `script-src 'self'` is safe. daisyUI/theming may rely on
  inline style attributes, which `style-src 'unsafe-inline'` permits; this
  does not weaken script execution.
- **Alternatives considered**: fully strict `style-src 'self'` — risk of
  broken theming for zero security gain; hash/nonce-based — overkill for a
  static Vite bundle.

## R7: Key-scope normalisation

- **Decision**: Segment-aware checks: `normalizePrefix` rejects any `..`
  segment; `isSafeRelativePrefix` (listing/upload folder) already splits on
  `/` and rejects `..` — retained; `assertKeyInScope` rejects keys containing
  a `..` segment (defense in depth), surfacing the existing RangeError →
  400 out_of_scope path.
- **Rationale**: S3 keys are opaque, so `..` cannot traverse buckets today,
  but accepting parent-traversal segments in scope checks is fragile and
  confusing; normalising costs nothing and removes the class of bug if the
  storage layer ever normalises paths.
- **Alternatives considered**: full canonicalisation of keys (resolve `..`
  lexically) — changes accepted key semantics for no current benefit;
  rejected in favour of rejection.

## R8: Reset-created re-enrollment invite

- **Decision**: `DELETE /api/admin/users/{id}/passkeys` changes from 204 to
  200 with `{invite, link}`: delete credentials, delete ALL sessions for the
  user, cancel pending invites for the username, create a fresh 48h invite
  with the user's bucket/prefix/isAdmin, return the link. Admin UI shows the
  link in the reset dialog (mirrors invite-creation UX).
- **Rationale**: Revocation (C2) + a single live token-gated recovery path;
  reuses the invite machinery and the US1 attach semantics; claimed invites
  stay for audit.
- **Alternatives considered**: keep 204 and require the admin to create an
  invite manually — two-step, easy to forget, leaves an open window — rejected.

## R9: Helm hardening

- **Decision**: Container-level `securityContext`: `readOnlyRootFilesystem:
  true` (the `/data` PVC mount stays writable), `allowPrivilegeEscalation:
  false`, `capabilities.drop: [ALL]`, `seccompProfile: {type: RuntimeDefault}`;
  pod-level keeps `runAsNonRoot` + `fsGroup`. Default `resources` in
  `values.yaml`: requests 100m/128Mi, limits 500m/512Mi.
- **Rationale**: Standard pod hardening; the app's only write target is the
  SQLite DB on `/data`; read-only rootfs breaks nothing (verified by the
  deployment smoke test in US7).
- **Alternatives considered**: leave defaults unset (status quo — rejected);
  add an `Ingress`/NetworkPolicy — out of scope (terminator is external).

## R10: Target branch and test strategy

- **Decision**: All changes land on `004-passkey-login` (deployed code).
  Tests follow house conventions: `bun test backend/tests/` (backend),
  `vitest` (frontend), Playwright e2e (`bun run test:e2e`); contract updates
  in `contracts/openapi.yaml` (bump to 1.2.0); e2e specs that used the
  username fallback form switch to invite-based enrollment; `e2eServer.ts`
  seeds an invite for the fallback flows.
- **Rationale**: The live site runs 004; fixing `main` alone would leave the
  deployed code vulnerable. House test runners and spec layout are already
  established (001–004).
- **Alternatives considered**: fix `main` and merge to 004 — the branches have
  diverged substantially; reconciliation is tracked separately (Assumption).
