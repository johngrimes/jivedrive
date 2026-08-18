# Requirements Checklist: Security Hardening

**Purpose**: Validate that `spec.md` for `005-security-hardening` is complete,
unambiguous, and ready for planning.
**Created**: 2026-08-18
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] CHK001 Spec is about WHAT and WHY, not HOW — no tech stack or code
      structure (choices live in plan.md/research.md).
- [x] CHK002 Focused on user value: each user story is a user-visible outcome
      (enrollment security, reset recovery, 429 behaviour, headers, session
      expiry, scope rejection, hardened deployment).
- [x] CHK003 Mandatory sections present: User Scenarios & Testing, Edge Cases,
      Functional Requirements, Key Entities, Success Criteria, Assumptions.
- [x] CHK004 No `[NEEDS CLARIFICATION]` markers remain.

## Requirement Completeness

- [x] CHK005 Every FR is testable and unambiguous (single behaviour, precise
      trigger and outcome; e.g. FR-003 names the env var and the constant-time
      compare).
- [x] CHK006 Success criteria are measurable and technology-agnostic
      (SC-001..SC-009 map 1:1 to the FRs and to the review findings C1/C2/H1/H2/
      M1/M2/M3/M4).
- [x] CHK007 Acceptance scenarios defined for every user story (Given/When/Then
      sets per story).
- [x] CHK008 Edge cases covered: bootstrap token reuse/rotation, wrong-token
      response, pending-invite cancellation, attach mismatch, 429 vs challenge
      state, CSP vs daisyUI, read-only rootfs, legacy-session backfill, e2e
      seeding, enumeration remainder, untouched file behaviours.
- [x] CHK009 Scope bounded: operational actions (register john's passkey, bucket
      verification, PVC backup), CI SHA-pinning, and audit logging are
      explicitly out of scope; branch reconciliation noted as an Assumption.
- [x] CHK010 Assumptions recorded: target branch, terminator behaviour, no new
      dependencies, single-replica correctness, default limit values, invite
      lifetime reuse, Register-page reuse.

## Feature Readiness

- [x] CHK011 Every FR maps to at least one user story and one success
      criterion (FR-001..FR-005→US1/SC-001..003, FR-006→US2/SC-003, FR-007..008→
      US3/SC-004, FR-009..010→US4/SC-005, FR-011→US5/SC-006, FR-012→US6/SC-007,
      FR-013→US7/SC-008).
- [x] CHK012 User stories are independently testable increments, each with an
      Independent Test line.
- [x] CHK013 Priority ordering reflects risk: P1 = takeover/enumeration closes,
      P2 = rate limiting + headers, P3 = lifecycle, scoping, deployment.

## Notes

- FR-006 (reset revokes own session) deliberately changes the 004 behaviour
  where self-reset kept the session alive; the returned link prevents a dead
  end (spec US2 scenario 3).
- The rate-limit defaults in Assumptions are inputs to plan.md research;
  exact values are env-configurable per FR-007.
