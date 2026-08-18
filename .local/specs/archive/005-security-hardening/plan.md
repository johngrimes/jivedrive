# Implementation Plan: Security Hardening

**Feature**: `005-security-hardening` | **Date**: 2026-08-18 | **Spec**: [spec.md](spec.md)

## Summary

Close the review's critical/high/medium findings on the deployed JiveDrive:
token-gate all first-passkey enrollment (delete the username-first flow),
make admin passkey reset revoke sessions and issue a re-enrollment invite,
add rate limiting, security headers, session idle timeout + startup purge,
segment-aware key scoping, and hardened Helm defaults. Targets branch
`004-passkey-login` (the deployed code).

## Technical Context

**Language/Version**: TypeScript 5.9 (Bun 1.3.14 runtime, matching
`docker/Dockerfile` and CI)
**Primary Dependencies**: Hono 4 + @simplewebauthn/server 13 + @aws-sdk
(v3) — no new dependencies (Constitution II)
**Storage**: SQLite (bun:sqlite) with the migration runner in
`backend/src/db/migrate.ts`; S3 (OVHcloud) for objects
**Testing**: `bun test backend/tests/`; vitest `frontend/tests/`; Playwright
`e2e/` (`bun run test:e2e`); `helm template` assertions for the chart
**Target Platform**: single container (Bun) on Kubernetes (minikube, deploy
via `.github/workflows/quality-and-deploy.yml`); TLS terminated externally
**Project Type**: web-app (SPA + REST API in one Hono server)
**Performance Goals**: rate limiting must not disturb a single user's normal
use (defaults 20/min auth, 300/min files); touch-on-validate is one indexed
UPDATE per request
**Constraints**: single replica (Recreate strategy) — in-memory rate-limit
and challenge state is correct; no new dependencies; all changes on
`004-passkey-login`
**Scale/Scope**: personal drive — 1–10 users

## Constitution Check

_GATE: per project CLAUDE.md. Re-checked after the design is drafted._

| Principle | Honour |
| --------- | ------ |
| I. Test-First (NON-NEGOTIABLE) | Every story's tests are written first and confirmed failing; full suite green at each checkpoint. |
| II. Simplicity | No new dependencies (hand-rolled bucket + header middleware, ~100 lines total). One mechanism (tokens) replaces the username flow; attach reuses existing invite machinery. |
| III. Functional TypeScript | Plain functions, no classes; every exported function JSDoc'd (existing house style). |
| IV. Scope Containment | Segment-aware scope checks strengthen the existing route-layer enforcement; covered by tests. |
| V. Visibility of System Status | 429 responses carry Retry-After + JSON error; reset dialog surfaces the re-enrollment link; no silent failures. |
| VI. Mobile-First UI | Frontend changes are additive (remove a form, show a link in an existing dialog); responsive e2e suite still green. |
| Security | Passkeys only (unchanged); enrollment secrets come from environment config, never the repo; sessions stay httpOnly/Secure/SameSite=Lax. |

No violations.

## Project Structure

### Documentation (this feature)

```text
.local/specs/005-security-hardening/
├── spec.md
├── plan.md            # This file.
├── research.md        # R1–R10 decisions.
├── data-model.md      # Session.lastUsedAt, attach invariant, invite transitions.
├── quickstart.md      # End-to-end scenarios + ops actions.
├── contracts/         # openapi.yaml v1.2.0.
├── checklists/        # requirements.md.
└── tasks.md           # Generated last.
```

### Source code (repository root, branch `004-passkey-login`)

```text
backend/
├── migrations/
│   └── 003_session_last_used.sql        # new (US5)
├── src/
│   ├── config.ts                        # new env vars + validation (US1/US3/US5)
│   ├── server.ts                        # middleware wiring, startup sweep (US3/US4/US5)
│   ├── security/                        # new directory
│   │   ├── headers.ts                   # header middleware (US4)
│   │   └── rateLimit.ts                 # token-bucket middleware (US3)
│   ├── auth/
│   │   ├── sessions.ts                  # idle expiry, touch, revoke-all (US2/US5)
│   │   └── webauthn.ts                  # unchanged
│   ├── routes/
│   │   ├── auth.ts                      # token-only enrollment, bootstrap token, attach (US1)
│   │   ├── admin.ts                     # reset → invite + revoke (US2)
│   │   └── files.ts                     # unchanged (scoping lives in s3/client.ts)
│   ├── s3/client.ts                     # segment-aware assertKeyInScope (US6)
│   ├── db/repository.ts                 # lastUsedAt, deleteSessionsByUser, prefix ".." rejection (US5/US6/US1)
│   └── e2eServer.ts                     # seed invite for e2e enrollment flows
└── tests/                               # bun test — new/updated suites per story
frontend/
├── src/
│   ├── api/client.ts                    # drop username params; reset response type (US1/US2)
│   ├── pages/SignIn.tsx                 # remove fallback form (US1)
│   ├── pages/Register.tsx               # minor copy (token-only) (US1)
│   └── pages/AdminUsers.tsx             # reset shows re-enrollment link (US2)
└── tests/                               # vitest — client + component tests
e2e/
├── auth.spec.ts                         # invite-based enrollment instead of fallback form (US1)
├── admin.spec.ts                        # reset → link assertions (US2)
└── helpers.ts                           # enrollment helper via invite token
deploy/helm/jivedrive/
├── templates/deployment.yaml            # hardened securityContext + resources (US7)
├── values.yaml                          # resource defaults, new config vars (US7)
├── values-ci.yaml                       # resource defaults inherit (US7)
└── README.md                            # new env vars + reset UX (US7)
```

**Structure Decision**: new `backend/src/security/` directory for the two
middlewares (headers, rate limit); everything else extends existing files.
No schema changes beyond migration 003.

## Phase 0: Research

All technical questions resolved; see `research.md` (R1–R10) for decisions,
rationale, and rejected alternatives.

## Phase 1: Design & Contracts

- **Data model** (`data-model.md`): `sessions.lastUsedAt` (migration 003,
  backfilled from `createdAt`); invite attach invariant (bucket/prefix/isAdmin
  equality + zero discoverable credentials); invite state transitions
  extended (pending → deleted on reset); bootstrap token is config, not data;
  rate-limit state is in-memory.
- **Contracts** (`contracts/openapi.yaml` v1.2.0): `register/options` and
  `register/verify` are token-only (invite or bootstrap token); reset
  endpoint returns `{invite, link}` (200); 429 `rate_limited` + Retry-After
  documented on all `/auth` and `/api` paths.
- **Quickstart** (`quickstart.md`): five verification scenarios plus the
  three operational actions from the review.

## Phase 2+: Tasks

See `tasks.md`. Execution order: Foundational (migration + config + session
repo plumbing) → US1 (enrollment gate, P1) → US2 (reset + revocation, P1) →
US3 (rate limiting) → US4 (headers) → US5 (idle timeout + sweep) → US6 (key
scoping) → US7 (chart) → Polish.

## Constraints / Out of scope

- Operational actions (register `john`'s passkey, bucket privacy check, PVC
  backup) are documented in `quickstart.md` and are NOT tasks.
- CI action SHA-pinning and audit logging are out of scope (spec Assumptions).
- `main` reconciliation happens separately after this feature lands on
  `004-passkey-login`.
