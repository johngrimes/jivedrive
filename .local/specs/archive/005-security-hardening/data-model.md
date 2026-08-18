# Data Model: Security Hardening

**Feature**: `005-security-hardening` | **Date**: 2026-08-18 | **Spec**: [spec.md](spec.md)

## Entities

### User (unchanged)

| Field | Type | Notes |
| ----- | ---- | ----- |
| id | TEXT PK | |
| username | TEXT UNIQUE | |
| bucket | TEXT NOT NULL | Storage scope. |
| prefix | TEXT NOT NULL | Storage scope, normalised to end with `/`, never containing a `..` segment (FR-012). |
| isAdmin | INTEGER | |
| createdAt | TEXT | |

**Invariant for attach claims (new)**: when an invite targets a username that
already exists, the claim is allowed only if `bucket`, `prefix`, and `isAdmin`
are identical between the invite and the existing user, and the user holds
zero discoverable passkeys. No re-scope, no privilege change (FR-004).

### PasskeyCredential (unchanged)

| Field | Type | Notes |
| ----- | ---- | ----- |
| id | TEXT PK | base64url credential id. |
| userId | TEXT FK → users ON DELETE CASCADE | |
| publicKey | TEXT | |
| counter | INTEGER | |
| transports | TEXT (JSON) | |
| discoverable | INTEGER | 1 = usable username-less. **Enrollment gate**: a first-passkey claim (invite or bootstrap) requires zero discoverable credentials for the target user. |
| createdAt / lastUsedAt | TEXT | |

### Invite (semantics change, no schema change)

| Field | Type | Notes |
| ----- | ---- | ----- |
| id | TEXT PK | |
| token | TEXT UNIQUE | 256-bit random; single-use. |
| username / bucket / prefix / isAdmin | | Claim target. For attach claims these MUST equal the existing user's values. |
| issuedByUserId | TEXT FK | |
| expiresAt | TEXT | 48h for admin-issued invites and reset-created invites. |
| claimedByUserId / claimedAt | TEXT NULL | Set on claim; claimed invites are never deleted (audit). |
| createdAt | TEXT | |

**State transitions** (extended from 004):

- `pending → claimed`: token redeemed; creates the user if absent, or attaches
  a passkey to the existing user (attach path) when FR-004 holds. Either way
  the passkey is created with `discoverable = 1`.
- `pending → deleted`: admin cancellation **or** passkey reset (reset cancels
  pending invites for the username so exactly one live invite exists).
- `pending → expired`: past `expiresAt`, never claimed.
- `claimed`: terminal (kept for audit).

### Session (schema change — migration 003)

| Field | Type | Notes |
| ----- | ---- | ----- |
| id | TEXT PK | |
| token | TEXT UNIQUE | 256-bit random, httpOnly cookie. |
| userId | TEXT FK → users ON DELETE CASCADE | |
| createdAt | TEXT | |
| expiresAt | TEXT | Absolute TTL (30d default, `JIVEDRIVE_SESSION_TTL_DAYS`). |
| **lastUsedAt** | TEXT NULL (new) | Backfilled from `createdAt` by migration 003. Rolling idle clock. |

**Validity** (FR-011): `now < expiresAt` AND `now - lastUsedAt < idleDays`
(`JIVEDRIVE_SESSION_IDLE_DAYS`, default 7). Valid validation touches
`lastUsedAt = now` (rolling window). Deleted when invalid (lazy purge) or by
the startup sweep.

**Revocation**: `DELETE /api/admin/users/{id}/passkeys` deletes every session
row for the user (including the caller's own when resetting self — FR-006).
User deletion continues to cascade sessions (unchanged).

### Bootstrap enrollment token (configuration, not data)

- Source: env `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN`; required when
  `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` is set (config validation error
  otherwise — mirrors the existing bucket-required rule).
- Check: constant-time compare at `register/options` and re-checked at
  `register/verify`; second gate = target user exists and has zero
  discoverable credentials. Inert once enrolled; rotate = restart with a new
  value. Never stored in the database.

### Rate-limit state (in-memory, not persisted)

- Token buckets keyed by `(family, identity)`; family = `/auth/*` |
  `/api/files/*`; identity = leftmost `X-Forwarded-For` when
  `JIVEDRIVE_TRUST_PROXY=true`, else socket remote address.
- Buckets pruned lazily (stale by idle window) with a size cap; reset on
  restart (single-replica deployment — correct).

## Validation rules (unchanged except where noted)

- `validateUsername`: `[a-z0-9][a-z0-9._-]{0,31}` — unchanged.
- `validateBucket`: S3 bucket name — unchanged.
- `normalizePrefix`: no leading `/`, exactly one trailing `/`, and **now
  rejects any `..` segment** (FR-012). Used by invite creation, bootstrap
  config, and config load.
- `assertKeyInScope`: key starts with the user prefix **and** contains no `..`
  segment (FR-012, defense in depth). RangeError → 400 out_of_scope.

## Migration

`backend/migrations/003_session_last_used.sql`:

```sql
ALTER TABLE sessions ADD COLUMN lastUsedAt TEXT;
-- Backfill: pre-existing sessions start with a full idle allowance.
UPDATE sessions SET lastUsedAt = createdAt WHERE lastUsedAt IS NULL;
```
