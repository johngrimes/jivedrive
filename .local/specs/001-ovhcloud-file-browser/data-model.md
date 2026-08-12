# Phase 1 Data Model: JiveDrive

SQLite database (`jivedrive.db`) on a Kubernetes PVC. Schema versioned by
ordered migration files in `backend/migrations/`, applied at startup.

## Entities

### User

A registered account scoped to a bucket and prefix.

| Field | Type | Constraints |
| ----- | ---- | ----------- |
| `id` | TEXT (UUID) | PK |
| `username` | TEXT | UNIQUE, NOT NULL |
| `bucket` | TEXT | NOT NULL |
| `prefix` | TEXT | NOT NULL, normalised to end with `/` (may be empty string for bucket root) |
| `isAdmin` | INTEGER (0/1) | NOT NULL, default 0 |
| `createdAt` | TEXT (ISO 8601) | NOT NULL |

Validation: `username` matches `[a-z0-9][a-z0-9._-]{0,31}`; `bucket` is a valid
S3 bucket name; `prefix` has no leading `/` and ends with `/`.

Relationships: one user has zero or more `PasskeyCredential`s; a user may be
the `issuedBy` of many `Invite`s.

### PasskeyCredential

A registered WebAuthn credential (public key) for a user. A user may register
several (one per device/browser).

| Field | Type | Constraints |
| ----- | ---- | ----------- |
| `id` | TEXT | PK (WebAuthn credential ID, base64url) |
| `userId` | TEXT | FK -> User.id, NOT NULL, ON DELETE CASCADE |
| `publicKey` | TEXT | NOT NULL (COSE/JSON-encoded public key) |
| `counter` | INTEGER | NOT NULL, default 0 |
| `transports` | TEXT (JSON array) | NOT NULL, default `[]` |
| `createdAt` | TEXT (ISO 8601) | NOT NULL |
| `lastUsedAt` | TEXT (ISO 8601) | nullable |

### Invite

A pending or claimed account invitation.

| Field | Type | Constraints |
| ----- | ---- | ----------- |
| `id` | TEXT (UUID) | PK |
| `token` | TEXT | UNIQUE, NOT NULL (cryptographic random for the invite link) |
| `username` | TEXT | NOT NULL |
| `bucket` | TEXT | NOT NULL |
| `prefix` | TEXT | NOT NULL |
| `isAdmin` | INTEGER (0/1) | NOT NULL, default 0 |
| `issuedByUserId` | TEXT | FK -> User.id, NOT NULL (admin who created it) |
| `expiresAt` | TEXT (ISO 8601) | NOT NULL (creation + 48 hours) |
| `claimedByUserId` | TEXT | FK -> User.id, nullable, set on successful registration |
| `claimedAt` | TEXT (ISO 8601) | nullable |
| `createdAt` | TEXT (ISO 8601) | NOT NULL |

### Session

An opaque server-side session tied to a signed-in user; the session token is
held in an httpOnly, Secure, SameSite=Lax cookie (`jivedrive_session`).

| Field | Type | Constraints |
| ----- | ---- | ----------- |
| `id` | TEXT (UUID) | PK |
| `token` | TEXT | UNIQUE, NOT NULL (cryptographic random) |
| `userId` | TEXT | FK -> User.id, NOT NULL, ON DELETE CASCADE |
| `createdAt` | TEXT (ISO 8601) | NOT NULL |
| `expiresAt` | TEXT (ISO 8601) | NOT NULL (created + TTL, default 30 days) |

## State transitions

- **Invite**: `pending` (created, unexpired) -> `claimed` (registered
  successfully) or `expired` (past `expiresAt`, never claimed) or `cancelled`
  (admin cancelled, removed from the table).
- **User**: `active` (exists in the table, passkey credentials present) ->
  `removed` (row deleted; storage objects untouched).
- **Session**: `valid` -> `ended` (sign-out) or `expired` (configurable TTL,
  default 30 days).

## Deletion rules

- Deleting a user cascades to their passkey credentials and to invites
  issued by them and invites with `claimedByUserId` pointing at them.
- Deleting an object in storage does not touch any database records (share
  links are never stored).
