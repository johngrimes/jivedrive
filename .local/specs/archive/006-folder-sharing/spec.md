# Feature Specification: Folder Sharing

**Feature**: `006-folder-sharing`
**Created**: 2026-08-23
**Status**: Draft

## Summary

JiveDrive users can share folders with other JiveDrive users. A share is a
persistent, revocable grant of full read/write access (browse, download,
upload/overwrite, delete) to a folder in the sharer's space. The recipient
sees the shared folder mounted at the root of their own space, visually
labelled with the sharer's username; opening it browses the sharer's folder
and allows the same operations the owner can perform there.

This is a distinct mechanism from the existing fire-and-forget anonymous
share links, which are unchanged: those remain generated-on-demand, never
stored, and expire naturally. The constitution's "fire-and-forget" clause is
amended to apply only to anonymous share links; user-to-user folder grants
are stored in the database, listed back to the owner, and revocable.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Share a folder with another user (Priority: P1)

Alice signs in, opens the share dialog on a folder in her space, searches for
a recipient by username, and shares the folder. The share is stored and the
folder now appears in the recipient's space root. Alice can see the list of
recipients for that folder at any time.

**Why this priority**: Creating a share is the core capability everything
else builds on; without it the feature does not exist.

**Independent Test**: Backend route tests create a share via the API and
assert the record persists; the recipient's listing endpoint returns the
mounted folder; the sharer's listing endpoint returns the share. Frontend
test opens the share dialog, searches the user list, and confirms the
recipient in the dialog's list.

**Acceptance Scenarios**:

1. **Given** Alice signed in with a folder `projects` in her space, **When**
   she shares `projects` with Bob, **Then** the share is stored with Alice as
   owner and Bob as recipient, and the dialog shows Bob in the recipient
   list.
2. **Given** Alice shares `projects` with Bob, **When** Bob loads his space
   root, **Then** a folder row `projects` labelled "Shared by alice" appears
   alongside his own folders.
3. **Given** Alice opens the share dialog on a folder that already has
   recipients, **When** she inspects it, **Then** each recipient's username
   and share date are listed.
4. **Given** Alice attempts to share `projects` with Bob a second time,
   **When** she submits, **Then** the request is refused (409) and the
   existing share is unchanged.
5. **Given** Alice attempts to share a folder with herself, **When** she
   submits, **Then** the request is refused (400).
6. **Given** Alice attempts to share her space root, **When** she opens the
   share dialog on the root, **Then** no share action is offered (root is not
   shareable).
8. **Given** alice has shared `projects` with bob, **When** she loads her
   space root, **Then** the `projects` row shows a visible "Shared"
   indicator.
- **Cross-bucket shares**: shares may target a user on a different bucket.
  The service holds one S3 credential pair; a share works only if that
  credential can access the sharer's bucket, otherwise S3 returns
  AccessDenied at request time. Documented limitation; no special handling.
- **Anonymous link inside a shared folder**: the recipient may generate a
  fire-and-forget share link for a file in a shared folder — a timed
  anonymous download grant of content they can already download. Not
  re-sharing (FR-015); the link expires naturally like any other.
- **FR-017**: The project constitution MUST be amended so the
  "fire-and-forget" security clause applies only to anonymous share links,
  and user-to-user folder grants are stated as stored, listed, and
  revocable. [US4]
- **FR-018**: Folder rows at the space root that have outgoing shares MUST
  show a visible "Shared" indicator. [US1]

### User Story 2 - Recipient browses and downloads from a shared folder (Priority: P1)

Bob sees `projects` mounted in his space root, opens it, navigates its
subfolders, and downloads files — exactly as in his own space.

**Why this priority**: Reading shared content is the primary value of a
share; it is the minimal recipient capability.

**Independent Test**: Backend route tests list a shared folder's contents
under the sharer's prefix and produce a download URL for a key inside it.
Playwright test signs in as Bob, opens the mounted folder, navigates a
subfolder, and downloads a file.

**Acceptance Scenarios**:

1. **Given** `projects` shared with Bob contains `docs/report.pdf`, **When**
   Bob opens `projects` and then `docs`, **Then** the listing shows
   `report.pdf` alongside any other contents.
2. **Given** Bob is viewing a file inside `projects`, **When** he clicks
   download, **Then** a download URL valid for the sharer's bucket and
   prefix is issued and the file downloads.
3. **Given** a shared folder that is empty, **When** Bob opens it, **Then**
   the empty state renders (no error).
4. **Given** a user with no shares, **When** they load their space root,
   **Then** no shared rows appear and their listing is unchanged.
5. **Given** two different sharers each share a folder named `docs` with
   Bob, **When** Bob loads his root, **Then** both rows appear, each labelled
   with its sharer's username.
6. **Given** Bob has his own folder named `projects` and also receives a
   share named `projects`, **When** he loads his root, **Then** both rows
   appear; the shared row is labelled "Shared by alice" and opens the
   sharer's folder, not his own.

### User Story 3 - Recipient uploads, overwrites, and deletes in a shared folder (Priority: P2)

Bob uploads new files into `projects` and its subfolders, overwrites
existing files (with the same overwrite confirmation as his own space), and
deletes files — all scoped to the sharer's folder.

**Why this priority**: Full read/write is a decided requirement; without it
the share is read-only. P2 because the recipient's read path (US2) must
exist before writes make sense.

**Independent Test**: Backend route tests presign an upload URL for a key
inside the shared prefix, assert overwrite-conflict behaviour, and delete an
object there. Playwright test uploads and deletes a file inside the shared
folder as Bob.

**Acceptance Scenarios**:

1. **Given** Bob is inside `projects` (shared by Alice), **When** he uploads
   `notes.txt`, **Then** the upload is stored under Alice's prefix and
   appears in both Bob's view and Alice's own listing.
2. **Given** `projects/notes.txt` already exists, **When** Bob uploads a new
   `notes.txt` without overwrite consent, **Then** the upload is refused
   (409) and the existing object is unchanged.
3. **Given** Bob confirms overwrite, **When** he uploads `notes.txt`, **Then**
   the object is replaced.
4. **Given** Bob is inside a shared folder, **When** he deletes a file,
   **Then** the object is deleted from the sharer's space and disappears from
   both listings.
5. **Given** Bob attempts to write to a path outside the shared folder (e.g.
   a key escaping the shared prefix), **When** the request is processed,
   **Then** it is refused (400) — shared access never widens scope beyond
   the shared prefix.

### User Story 4 - Owner revokes a share (Priority: P2)

Alice removes Bob from the recipient list of `projects`. The share record is
deleted, and Bob loses all access immediately: the mount disappears and
further requests against the folder are refused.

**Why this priority**: Revocation is the trust control that makes persistent
sharing safe; decided as part of the lifecycle model. P2 because sharing and
reading (US1/2) precede the need to revoke.

**Independent Test**: Backend route tests revoke a share and assert the
record is gone and subsequent listing/upload/download/delete requests by the
former recipient are refused. Playwright test revokes from the dialog and
asserts the mount disappears for Bob.

**Acceptance Scenarios**:

1. **Given** `projects` is shared with Bob, **When** Alice revokes the share,
   **Then** the share record is deleted and the dialog's recipient list no
   longer shows Bob.
2. **Given** the revoked share, **When** Bob reloads his space root, **Then**
   the mounted row is gone.
3. **Given** the revoked share, **When** Bob requests a listing, download,
   upload, or delete inside the former shared prefix, **Then** the request is
   refused (404) as the share no longer exists.
4. **Given** Bob holds a download URL issued before revocation, **When** he
   follows it, **Then** it may still work until its 15-minute lifetime ends —
   presigned URLs cannot be invalidated early (accepted limitation, not a
   bug).
5. **Given** Alice revokes a share and then shares the same folder with Bob
   again, **When** she submits, **Then** the share is created afresh.

### User Story 5 - Account deletion cleans up shares (Priority: P3)

When an admin deletes a user, every share that user owned and every share
granted to that user is removed with the account. No orphan share records
survive, and no mount can point at a deleted user's folder.

**Why this priority**: Data hygiene for an existing admin operation; the
feature works without it but would accumulate dead records. P3 because it is
only reachable via the admin UI.

**Independent Test**: Backend route tests delete a user and assert their
outgoing and incoming share records are gone and the surviving user's
listing is unaffected.

**Acceptance Scenarios**:

1. **Given** Alice shares `projects` with Bob and Bob shares `docs` with
   Alice, **When** an admin deletes Bob, **Then** both share records are
   gone; Alice's listing shows neither `docs` (mounted from Bob) nor a stale
   recipient entry for Bob.
2. **Given** the deleted recipient's shares, **When** Alice loads her root,
   **Then** no rows reference the deleted user.

### Edge Cases

- **Share of a subfolder**: sharing `projects` shares the whole subtree;
  subfolders need no separate records. A user may hold overlapping shares
  (e.g. `projects` and `projects/docs`) — both mount independently; harmless
  redundancy.
- **Name collisions**: the recipient's own folder and an incoming share with
  the same name both appear; the shared row is labelled with the sharer's
  username. Two shares with the same name from different sharers also
  coexist via the label.
- **Empty or not-yet-existing folder**: sharing is prefix-based; an empty or
  absent folder shares fine and the recipient sees the empty state.
- **Presigned URLs after revocation**: URLs issued before revocation remain
  valid up to their 15-minute lifetime (SigV4 presigning cannot be undone).
  Revocation enforcement happens when URLs are issued, so no new URLs are
  signed after revocation.
- **Cross-bucket shares**: shares may target a user on a different bucket.
  The service holds one S3 credential pair; a share works only if that
  credential can access the sharer's bucket, otherwise S3 returns
  AccessDenied at request time. Documented limitation; no special handling.
- **Duplicate share**: same folder + same recipient is refused with 409; the
  existing share is untouched.
- **Self-share**: refused with 400.
- **Root share**: the space root cannot be shared; the share action exists
  only on subfolders.
- **Recipient of a share cannot re-share**: shares are created and revoked
  only by the folder's owner; the recipient's share dialog (or equivalent)
  is absent for received folders.
- **Recipient's own space is untouched**: mounted folders never appear
  nested inside the recipient's own folders — mounts exist only at the
  space root.
- **Deleting the sharer's folder contents**: does not remove the share; the
  mount persists (showing the empty state) until revoked.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: A signed-in user MUST be able to share any subfolder of their
  own space with another signed-in user by username. [US1]
- **FR-002**: Each share MUST record the owner, the recipient, the shared
  folder (relative to the owner's space), and the creation time. [US1]
- **FR-003**: A share MUST be persistent until revoked; there is no expiry
  mechanism. [US1]
- **FR-004**: Sharing the space root MUST be refused. [US1]
- **FR-005**: Sharing a folder already shared with the same recipient MUST
  be refused (409); sharing with oneself MUST be refused (400). [US1]
- **FR-006**: Any signed-in user MUST be able to search for other users by
  username to pick a recipient; the search result MUST expose only identity
  (username), never bucket, prefix, or admin status. [US1]
- **FR-007**: The owner MUST be able to see the list of recipients for each
  of their shared folders, with share dates. [US1]
- **FR-008**: Shared folders MUST appear mounted at the recipient's space
  root as folder rows, labelled with the sharer's username; a row must
  appear even when the recipient has a same-named folder of their own. [US2]
- **FR-009**: The recipient MUST be able to browse the shared folder's
  subfolders and download its files, scoped to the sharer's bucket and
  prefix. [US2]
- **FR-010**: The recipient MUST be able to upload new files and overwrite
  existing files inside the shared folder, with the same overwrite
  confirmation behaviour as their own space. [US3]
- **FR-011**: The recipient MUST be able to delete files inside the shared
  folder. [US3]
- **FR-012**: All operations on a shared folder MUST be refused when the
  requested key escapes the shared prefix; shared access MUST never widen
  the user's scope beyond the granted folder. [US3]
- **FR-013**: The owner MUST be able to revoke a share at any time; the
  record is deleted, the mount disappears from the recipient's root, and
  all subsequent requests by the former recipient against the folder are
  refused. [US4]
- **FR-014**: Deleting a user account MUST remove all shares owned by that
  user and all shares granted to that user. [US5]
- **FR-015**: Recipients MUST NOT be able to re-share a received folder to
  third parties; only the owner creates and revokes shares. [US1]
- **FR-016**: The existing fire-and-forget anonymous file share links MUST
  remain unchanged. [Polish]
- **FR-017**: The project constitution MUST be amended so the
  "fire-and-forget" security clause applies only to anonymous share links,
  and user-to-user folder grants are stated as stored, listed, and
  revocable. [US4]

### Key Entities

- **Share**: a grant of access to one folder. Attributes: owner (user),
  recipient (user), folder (relative path inside the owner's space),
  creation time. Lifecycle: created → revoked (deleted); no expiry state.
  Deleting either user removes their shares.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: An owner can complete a share (pick recipient, submit) with
  no more than one search query and one confirmation; the recipient sees the
  mount on their next page load.
- **SC-002**: After revocation, the mount disappears on the recipient's next
  page load and every API request against the folder returns the refusal
  code; no access path remains.
- **SC-003**: The full existing e2e suite (auth, files, share links,
  upload, delete, admin, theming, responsive) stays green; file share links
  behave exactly as before.
- **SC-004**: Shared-folder operations are covered end to end for browse,
  download, upload, overwrite, and delete at mobile, tablet, and desktop
  widths (constitution VI).
- **SC-005**: Deleting a user leaves zero orphan share records (verified by
  query after admin deletion).

## Assumptions

- **Recipient discovery**: usernames become visible to all signed-in users
  (search endpoint). Acceptable for a small-team personal drive; revisit if
  the user base grows.
- **Cross-bucket**: shares between users on different buckets are allowed;
  they function only when the single service credential can access the
  sharer's bucket. No credential expansion in this feature.
- **No notifications**: recipients are not notified; the mount appears on
  their next visit. No email or in-app notification system exists.
- **No admin oversight**: admins do not see or manage shares; that is out of
  scope.
- **Share identity is path-based**: JiveDrive has no rename/move feature, so
  the shared folder path is stable for the life of the share.
- **Single replica**: share state lives in the SQLite database on the PVC;
  no distributed coordination needed.
- **e2e seeding**: the e2e server seeds a second non-admin user (bob) to
  exercise sharing flows.
