# Quickstart: Folder Sharing

**Feature**: `006-folder-sharing` | **Date**: 2026-08-23

Key end-to-end scenarios, phrased for later validation against the running
app (SPA + API). Users: `alice` (owner) and `bob` (recipient), both
pre-seeded in the e2e server; `bob` is a new seed for this feature.

## Scenario 1: Alice shares a folder with Bob

1. Sign in as alice.
2. Open the share dialog on the folder `projects` in her space root.
3. Search for `bo` in the recipient picker; `bob` appears (identity only).
4. Select bob and confirm. The dialog now lists bob as a recipient.
5. API check: `GET /api/shares` as alice returns `outgoing` containing
   `{ folder: "projects/", recipient.username: "bob" }`.

## Scenario 2: Bob sees the mount and reads

1. Sign in as bob (fresh context, second browser).
2. Load the space root: a row `projects` labelled "Shared by alice"
   appears alongside his own folders, even if bob also has a folder named
   `projects` of his own.
3. Open `projects` → subfolder `docs` → file `report.pdf` downloads.
4. API check: `GET /api/files?space=shared:<shareId>&prefix=` lists the
   sharer's folder contents; `GET /api/files/download-url?space=shared:<shareId>&key=report.pdf`
   yields a working presigned URL.

## Scenario 3: Bob writes to the shared folder

1. Inside the mount, upload `notes.txt`; it appears in the listing.
2. Upload `notes.txt` again without overwrite consent → refused (409);
   with consent → replaced.
3. Delete `notes.txt`; it disappears from the listing.
4. API check: alice's own listing of `projects` shows the same changes
   (single source of truth: the sharer's prefix).

## Scenario 4: Revocation cuts access

1. Alice opens the share dialog on `projects` and revokes bob's share.
2. Bob reloads his root: the mount is gone.
3. API check: bob's `GET /api/files?space=shared:<id>` returns 404; the
   share no longer appears in alice's `outgoing`.

## Scenario 5: Account deletion cleans up shares

1. Admin deletes bob's account.
2. API check: no rows in `shares` reference bob as owner or recipient;
   alice's root listing and share dialogs show no trace of bob.

## Validation

- Backend: `bun run test` (routes-shares, scope, space-aware files tests).
- Frontend: `bun run test` (client + component tests).
- E2E: `bun run test:e2e` (share-folder.spec.ts at mobile, tablet and
  desktop widths; full suite stays green).
- Curl: `scripts/verify-folder-share.sh` against the e2e server.
- Contract: `contracts/openapi.yaml` v1.3.0 documents every endpoint used
  above.
