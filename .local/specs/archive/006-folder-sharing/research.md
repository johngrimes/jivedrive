# Phase 0 Research: Folder Sharing

**Feature**: `006-folder-sharing` | **Date**: 2026-08-23

## R1: Generic space resolver (user decision)

- **Decision**: Every `/api/files` operation carries an explicit `space`
  identifier: `own` or `shared:<shareId>`. A resolver in the route layer
  (`backend/src/scope.ts`) maps the space to the effective `{ bucket,
  prefix }` — the signed-in user's own bucket/prefix for `own`, or the
  sharer's bucket + `sharerPrefix + share.folder` for `shared:<shareId>` —
  and authorizes it (share exists and the caller is the recipient).
  Absent `space` defaults to `own` (backward-compatible default; the SPA
  always sends it explicitly).
- **Rationale**: The user chose the generic refactor over the per-route
  special case. One resolver is the single scope authority (constitution IV:
  scope enforcement in the route layer); the existing
  `assertKeyInScope(prefix, key)` machinery in `backend/src/s3/client.ts`
  continues to enforce keys against the *effective* prefix unchanged.
- **Alternatives considered**:
  - `share=<id>` query param only on the routes that need it: less
    upfront churn, but two parallel scope paths that drift; rejected by
    user choice.
  - Virtual key scheme (`share://<id>/<path>`): opaque, breaks the
    existing key contract and S3 client signatures; rejected.

## R2: Keys are relative to the mount

- **Decision**: In a shared space, the SPA sends keys and prefixes relative
  to the shared folder itself (the mount). The resolver computes the
  effective prefix (`sharerPrefix + share.folder`, normalised with a
  trailing slash); `download-url`, `upload-url`, listing and delete apply
  `assertKeyInScope` against that prefix exactly as for own space.
- **Rationale**: No key rewriting, no leaking the sharer's internal prefix
  into the SPA, identical validation path for both spaces.
- **Alternatives considered**: sending absolute keys into the sharer's
  prefix — leaks scope internals and makes the S3 assertion trivially
  bypassable if ever misused; rejected.

## R3: Share identity and uniqueness

- **Decision**: `shares.id` is a UUID (`randomUUID`, matching `users.id`);
  folder is stored relative to the owner's prefix, normalised with a
  trailing slash; a unique index on `(ownerUserId, recipientUserId, folder)`
  makes duplicates impossible (route maps to 409 `already_shared`). An
  empty folder is refused (400) — the root is not shareable (FR-004).
- **Rationale**: Matches existing id conventions; the unique index is the
  authoritative duplicate guard (also covers races).
- **Alternatives considered**: composite natural key without an id column —
  complicates delete-by-id and future auditing; rejected.

## R4: User search endpoint

- **Decision**: `GET /api/users?q=` — authenticated; case-insensitive
  substring match on username; excludes the caller; returns at most 20
  `{ id, username }` entries (no bucket/prefix/isAdmin).
- **Rationale**: Share dialog needs a picker (FR-006); the response is the
  minimum identity surface.
- **Alternatives considered**: admin-only picker (rejected — any user
  shares), returning full user rows (leaks scope internals; rejected).

## R5: Shares listing shape

- **Decision**: One `GET /api/shares` returns
  `{ incoming: [{ id, folder, folderName, sharer: { id, username } }],
  outgoing: [{ id, folder, folderName, recipient: { id, username },
  createdAt }] }`. Incoming feeds the root mounts; outgoing feeds the share
  dialogs; one round trip serves both.
- **Rationale**: Simplest client contract for the two consumers; personal
  drive scale means no pagination.
- **Alternatives considered**: two endpoints (`?direction=`), per-folder
  lookup — more requests, no benefit at this scale; rejected.

## R6: Revocation enforcement

- **Decision**: `DELETE /api/shares/:id` deletes the row (owner only;
  non-owner or unknown id → 404 `not_found`, no existence leak). Access
  enforcement happens at resolution time: once the row is gone, any
  `shared:<id>` request resolves to 404, so listing, download, upload and
  delete all stop immediately. Presigned URLs issued before revocation
  remain valid up to their 15-minute TTL (SigV4 cannot be undone) —
  accepted, documented edge case.
- **Rationale**: Resolution-time enforcement covers every operation with
  one check; no per-route revocation checks needed.
- **Alternatives considered**: a revokedAt tombstone — rows would accumulate
  and mounts would need filtering; hard delete is simpler and matches
  "revoked = gone".

## R7: Rate limiting for new endpoints

- **Decision**: Mount the existing files-family rate-limit middleware on
  `/api/shares/*` and `/api/users` in `server.ts` (the middleware today
  covers only `/auth/*` and `/api/files/*`).
- **Rationale**: The new endpoints are file-domain operations; one shared
  store, same bucket semantics.
- **Alternatives considered**: a new "shares" family — the store is shared
  anyway; the files family keeps the memory bound identical; rejected.

## R8: Error codes

- **Decision**: `400 invalid_folder` (unsafe/empty folder), `400
  cannot_share_with_self`, `404 user_not_found` (unknown recipient), `409
  already_shared`, `404 not_found` (unknown or foreign share id, on GET
  list revocation and on file ops in a revoked/foreign space).
- **Rationale**: Distinguishable machine codes for the SPA; uniform with
  the existing `jsonError` helper.

## R9: Anonymous share links inside a shared folder

- **Decision**: `POST /api/files/share-url` goes through the same resolver,
  so a recipient may generate a fire-and-forget link for a file in a shared
  folder. This is not re-sharing (FR-015) — the link is a timed, anonymous
  download grant of content the recipient can already download, and it
  expires naturally.
- **Rationale**: Uniform resolver behaviour, zero special cases; matches
  the constitution's fire-and-forget semantics for links.
- **Alternatives considered**: refusing share-url in shared spaces —
  inconsistent behaviour for no security gain; rejected.

## R10: E2E seeding and fixtures

- **Decision**: `e2eServer.ts` seeds a second non-admin user `bob`
  (`users/bob/` prefix, seeded objects, fixed session cookie following the
  alice pattern). No seeded shares — the e2e spec creates them through the
  UI, which also exercises the create path.
- **Rationale**: Mirrors the existing alice/admin seeding; creating shares
  in-spec keeps the setup minimal.
- **Alternatives considered**: seeding a pre-existing share for fast
  read-path tests — two sources of truth for share state; rejected.

## R11: Contract versioning

- **Decision**: `contracts/openapi.yaml` in this spec dir is v1.3.0 and
  supersedes the v1.2.0 copy in
  `.local/specs/archive/005-security-hardening/contracts/openapi.yaml`
  (same convention as 005).
- **Rationale**: The contract lives with the spec; the archive copy stays
  as the historical record.

## R12: Frontend navigation and mounts

- **Decision**: Navigation state is `{ space, prefix }`; URLs are
  `/files?space=shared:<id>&prefix=<rel>` (own space keeps the existing
  `/files?prefix=` shape plus `space=own`). Mount rows render only at the
  own-space root; breadcrumbs for a shared view start with the mount name
  and show "Shared by \<username\>".
- **Rationale**: Query-param navigation matches the existing
  `/files?prefix=` pattern; mounts at root only avoids the ambiguity of
  nested virtual folders (spec edge case).
- **Alternatives considered**: nested mounts inside own folders — breaks the
  "shares never mix with own tree" invariant; rejected.

## R13: Folder share button and dialog

- **Decision**: Folder rows gain a share button (people icon) opening
  `ShareDialog`: searchable recipient picker (debounced `GET /api/users`),
  add-recipient submit, live recipient list for that folder (filtered from
  `outgoing`) with per-row revoke. Received folders render no share button
  (no re-sharing). Own-space root rows with outgoing shares show a "Shared"
  chip.
- **Rationale**: Direct manipulation in place; visibility principle
  (constitution V).
- **Alternatives considered**: a separate "Sharing" page — extra navigation
  for a per-folder action; rejected.

## R14: Migration numbering

- **Decision**: `004_shares.sql` (next after `003_session_last_used.sql`).
- **Rationale**: The migration runner applies files in order; numbers are
  never reused.
