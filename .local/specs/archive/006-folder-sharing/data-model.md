# Data Model: Folder Sharing

**Feature**: `006-folder-sharing` | **Date**: 2026-08-23 | **Spec**: [spec.md](spec.md)

## Entity: Share

A grant of full read/write access to one folder in the owner's space,
granted to one recipient. A folder may have many shares (one per
recipient); a recipient may hold many shares from many owners.

### Fields

| Field | Type | Constraints |
| ----- | ---- | ----------- |
| `id` | TEXT (UUID) | PRIMARY KEY; `randomUUID` |
| `ownerUserId` | TEXT | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `recipientUserId` | TEXT | NOT NULL, FK → `users(id)` ON DELETE CASCADE |
| `folder` | TEXT | NOT NULL; relative to the owner's prefix, normalised with trailing `/`; non-empty (root not shareable); never contains `..` segments |
| `createdAt` | TEXT (ISO 8601) | NOT NULL |

### Indexes

- `UNIQUE (ownerUserId, recipientUserId, folder)` — one share per
  owner/recipient/folder (duplicate → 409 `already_shared`).
- `(ownerUserId)` — outgoing list and dialogs.
- `(recipientUserId)` — incoming mounts and resolution.

### Validation (route layer)

- `folder`: must be a safe relative prefix (`isSafeRelativePrefix`), must
  not be empty after normalisation (root disallowed), normalised to end
  with `/`.
- `recipientUserId`: must reference an existing user, different from the
  caller.
- Uniqueness enforced by the index; the route maps the constraint error
  (or pre-checks) to 409.

### State transitions

```
created  ──(DELETE /api/shares/:id, owner only)──►  deleted (row removed)
```

No expiry state; no paused/disabled states. Deletion of either user
cascades and removes the share (FR-014). Revocation is enforced at request
resolution time: a gone row makes every `shared:<shareId>` request fail
with 404.

### Queries

- By id (resolution, revocation): `SELECT * FROM shares WHERE id = ?`.
- By recipient (incoming): `SELECT … WHERE recipientUserId = ? ORDER BY
  createdAt`.
- By owner (outgoing): `SELECT … WHERE ownerUserId = ? ORDER BY createdAt`.
- Cascades: handled by `ON DELETE CASCADE` on both FKs (matching the
  existing `passkey_credentials`/`invites`/`sessions` pattern; FK
  enforcement is already enabled — verify in `openDatabase`).

### Deletion rules (existing, extended)

- Deleting a user removes their credentials, invites, sessions **and now
  shares in both directions**; storage objects are untouched (their folder
  simply stops being mountable — the share record is gone).

## Relationships

```
users 1 ──< shares >── 1 users
ownerUserId  ──────────  recipientUserId
```

A share never exists without both users; neither side is optional.
