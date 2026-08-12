# Implementation Plan: JiveDrive

**Feature**: `001-ovhcloud-file-browser` | **Date**: 2026-08-12 | **Spec**: [spec.md](spec.md)

## Summary

JiveDrive is a web app that layers a simple file browser over OVHcloud Object
Storage (S3-compatible API). Multi-user, authenticated with platform passkeys
(WebAuthn). Each user is scoped to an admin-configured bucket and prefix.
Features: browse folders, download, single-file upload with overwrite
confirmation, permanent delete, and fire-and-forget presigned share links with
a 7-day default expiry. Deployed on Kubernetes via a Helm chart.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), bun as package manager
**Primary Dependencies**: React 19 + Vite (SPA), Hono (REST API), `@aws-sdk/client-s3`, `simplewebauthn`, `better-sqlite3`
**Storage**: SQLite database file on a Kubernetes PVC (users, passkey credentials, invites); object storage via OVHcloud S3
**Testing**: Vitest (unit + integration), Playwright (end-to-end)
**Target Platform**: Modern evergreen browsers; Kubernetes cluster
**Project Type**: web-app (SPA + API in a single container)
**Performance Goals**: folder listing renders within 1s for up to 1000 objects
**Constraints**: WebAuthn requires a secure origin - production origin `https://drive.grimes.id.au`, localhost supported for development
**Scale/Scope**: single-digit users, single replica (SQLite), one OVHcloud project

## Constitution Check

_GATE: the constitution is the user's CLAUDE.md (global; no project-level file
exists yet). Re-checked after the design was drafted._

- **Simplicity**: single container (API serves the built SPA), one database,
  no ORM, no message queues, no share-link tracking. The AWS SDK, Hono and
  simplewebauthn are the only significant dependencies and each earns its
  place (S3 protocol, HTTP, WebAuthn respectively).
- **Test-driven development**: tasks order tests before implementation in
  every phase (see `tasks.md`).
- **Language/framework rules**: TypeScript end-to-end, functional style, no
  classes, lower camelCase file names, Vite for React, JSDoc on exported
  functions, Prettier defaults, ESLint per `typescript-static-analysis.md`.
- **Visibility of system status**: uploads show progress and completion,
  listings render skeletons while loading, every action surfaces success or
  error feedback, sign-in state is explicit.
- **Deployment**: Docker image + Helm chart per the helm-charts skill
  conventions; PVC-backed SQLite; single replica with `Recreate` strategy.

| Violation | Why needed | Simpler alternative rejected because |
| --------- | ---------- | ------------------------------------ |
| None | - | - |

## Project Structure

### Documentation (this feature)

```text
.local/specs/001-ovhcloud-file-browser/
├── spec.md
├── plan.md            # This file.
├── research.md        # Phase 0 output.
├── data-model.md      # Phase 1 output.
├── quickstart.md      # Phase 1 output.
├── contracts/         # Phase 1 output (REST API, OpenAPI 3).
├── wireframes/        # Lo-fi HTML wireframes.
├── checklists/        # Quality checklists.
└── tasks.md           # Generated last.
```

### Source code (repository root)

```text
jivedrive/
├── backend/
│   ├── src/
│   │   ├── server.ts          # Hono app entry, static SPA serving.
│   │   ├── config.ts          # Environment configuration.
│   │   ├── db/                # better-sqlite3 schema + data layer.
│   │   ├── auth/              # WebAuthn (simplewebauthn) + sessions.
│   │   ├── s3/                # OVHcloud S3 client wrapper.
│   │   └── routes/            # REST route modules.
│   ├── migrations/            # SQL migration files.
│   └── tests/
├── frontend/
│   ├── src/
│   │   ├── pages/             # SignIn, Register, Files, AdminUsers.
│   │   ├── components/        # Listing, Breadcrumbs, ShareModal, etc.
│   │   └── api/               # Typed API client.
│   ├── index.html
│   └── tests/
├── deploy/helm/jivedrive/     # Helm chart (helm-charts skill conventions).
├── e2e/                       # Playwright end-to-end tests.
├── package.json               # bun workspaces root.
├── docker/
│   └── Dockerfile             # Multi-stage: build SPA, bundle backend.
└── docs/                      # Deployment and ops documentation.
```

**Structure Decision**: `backend/` and `frontend/` as bun workspaces sharing
one lockfile and root tooling; the production image runs the Hono server,
which serves the built SPA from `frontend/dist`, so deployment is one
container + one PVC + one SQLite file.

## Phase 0: Research

Resolve every open technical question into a decision recorded in `research.md`
using the format:

- **Decision**: [what was chosen]
- **Rationale**: [why]
- **Alternatives considered**: [what else was evaluated and why rejected]

Decisions covered: stack, WebAuthn library and flow (username-first,
non-discoverable credentials), SQLite library, S3 client configuration for
OVHcloud, session mechanism (opaque cookie sessions vs JWT), single-container
serving, test isolation (in-memory SQLite), Helm chart conventions.

## Phase 1: Design & Contracts

- **Data model** (`data-model.md`): users, passkey credentials, invites -
  fields, relationships, validation, state transitions.
- **Interface contracts** (`contracts/`): OpenAPI 3 specification of the REST
  API between the SPA and the backend.
- **Quickstart** (`quickstart.md`): end-to-end scenarios: bootstrap admin,
  invite, register, browse, upload, share, delete, remove user.
