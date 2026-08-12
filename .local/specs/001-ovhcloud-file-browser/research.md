# Phase 0 Research: JiveDrive

Each entry records a resolved technical question: decision, rationale,
alternatives considered.

## R1 - Backend stack

- **Decision**: TypeScript end-to-end. React 19 + Vite SPA frontend, Hono
  REST API backend, bun workspace.
- **Rationale**: Single language and toolchain across the project (per the
  user's conventions); mature WebAuthn and S3 ecosystems in Node; Hono is
  lightweight with first-class TypeScript.
- **Alternatives considered**: Python FastAPI backend - two toolchains, no
  benefit at this scale.

## R2 - WebAuthn flow

- **Decision**: Username-first sign-in with non-discoverable (platform)
  credentials, mediated by `simplewebauthn` on the server.
- **Rationale**: Every user has a fixed username chosen at invite time, so
  discoverable-credential "usernameless" mode adds no value and costs
  credential storage on the authenticator. `simplewebauthn` handles the
  WebAuthn ceremony (options, verification, counter handling) and is the
  de-facto Node library.
- **Alternatives considered**: Usernameless/discoverable credentials -
  extra complexity with no user benefit here; hand-rolled WebAuthn
  verification - error-prone, no reason to avoid the maintained library.

## R3 - Session mechanism

- **Decision**: Server-side opaque sessions (random token in an httpOnly,
  Secure, SameSite=Lax cookie), session records stored in SQLite.
- **Rationale**: Simplest correct approach for a single-replica app; enables
  immediate server-side sign-out; no key-management or expiry logic to
  hand-roll compared with JWT.
- **Alternatives considered**: JWT bearer tokens - revocability and secret
  rotation problems for zero benefit; signed-cookie sessions - equivalent
  complexity to opaque sessions with more crypto.

## R4 - SQLite access

- **Decision**: `better-sqlite3` with plain SQL and small typed data-layer
  modules; migrations as ordered SQL files applied at startup.
- **Rationale**: Synchronous, fast, zero ORM ceremony; plain SQL keeps the
  schema explicit and reviewable; startup-applied migrations are simple for a
  single-replica app.
- **Alternatives considered**: Drizzle ORM - adds a query builder and
  migration toolchain without simplifying this three-table schema; raw
  `node:sqlite` - less mature API surface than better-sqlite3.

## R5 - OVHcloud S3 client

- **Decision**: `@aws-sdk/client-s3` configured with the OVHcloud S3
  endpoint URL, region, and access keys from environment configuration;
  presigned URLs generated with `getSignedUrl` for download and share.
- **Rationale**: OVHcloud Object Storage exposes an S3-compatible API; the
  AWS SDK is the standard, well-tested client and produces standards-compliant
  presigned URLs that OVHcloud accepts.
- **Alternatives considered**: OpenStack Swift API with temporary URLs - the
  user chose S3-compatible; rolling our own SigV4 signing - unnecessary.

## R6 - Serving the frontend

- **Decision**: The Hono server serves the built SPA statically in
  production (single container); in development, Vite's dev server proxies
  API calls to Hono.
- **Rationale**: One container, one deployable unit, no CORS in production,
  no separate static file server.
- **Alternatives considered**: Separate nginx container for the SPA - an
  extra component with CORS and routing concerns for no benefit at this scale.

## R7 - Test isolation

- **Decision**: Tests use an in-memory SQLite instance (`:memory:`) per test
  where the unit under test touches the database; Playwright e2e tests run
  against a local app instance with a seeded database and a mock S3 layer.
- **Rationale**: Fast, hermetic tests with no shared state; the S3 client is
  behind a thin wrapper so e2e tests can substitute a stub.
- **Alternatives considered**: Testcontainers for Postgres - not applicable
  (SQLite); running e2e against real OVHcloud storage - slow, credential
  coupling, and dangerous (destructive delete tests).

## R8 - Helm chart conventions

- **Decision**: Chart follows the helm-charts skill: chart name `jivedrive`,
  values namespaced under a top-level `jivedrive` key, resources via
  `toJson`, PVC support with `enabled: false` default, health probes
  (startup/liveness/readiness), `Recreate` strategy (stateful app), no
  ingress resource in the chart (deployment-specific), `config` and
  `secretConfig` value groups, full README documentation.
- **Rationale**: The user explicitly asked to follow the helm-charts skill.
- **Alternatives considered**: Including an ingress resource - the skill
  explicitly excludes ingress from charts; bundling Postgres as a chart
  dependency - the user chose SQLite.

## R9 - Share link expiry

- **Decision**: Presigned URLs generated server-side with a per-request
  expiry chosen from a fixed set (1 hour, 24 hours, 7 days default, 30
  days); links are never stored.
- **Rationale**: Matches the agreed default 7-day expiry with per-link
  override, zero persistence, natural expiry by the storage provider.
- **Alternatives considered**: Storing share-link records for revocation -
  the user chose fire-and-forget links (no tracking, no revocation).

## R10 - Upload mechanism

- **Decision**: Single-file upload from the SPA via a presigned PUT URL
  obtained from the backend, with the backend's object key derived from the
  viewed folder and the file name. Overwrite requires an explicit
  confirmation flag in the request.
- **Rationale**: Presigned PUT keeps large payloads off the backend while the
  backend stays authoritative for key scoping and overwrite policy.
- **Alternatives considered**: Streaming the body through the backend - ties
  up the single replica's memory for no benefit; direct unauthenticated PUT
  from the browser - would bypass scoping and overwrite policy.
