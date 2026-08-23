# Quickstart validation

Validation of the scenarios in
[`.local/specs/001-ovhcloud-file-browser/quickstart.md`](../.local/specs/001-ovhcloud-file-browser/quickstart.md)
against a local instance with a mock S3 layer and a seeded database, plus
chart validation for the deployment path. Updated for spec
`005-security-hardening`: first-passkey enrollment is token-gated only
(invite token or bootstrap enrollment token), the admin passkey reset
returns a re-enrollment link and revokes sessions, and the app now ships
security headers, rate limiting and a hardened Helm chart.
Updated for spec `006-folder-sharing`: persistent user-to-user folder
grants (create/list/revoke via `/api/shares`, identity-only user search,
space-scoped `/api/files` operations on `shared:<shareId>`) are exercised
end to end and via curl; see the 006 section at the end of this document.

## Environment and method

- Commit: HEAD of branch `005-security-hardening` (working tree) - see
  `git log`.
- Local instance: the e2e server (`backend/src/e2eServer.ts`) serves the built
  SPA and the API on port 5173 with a file/in-memory SQLite database and an
  in-memory mock S3 store (mock S3 HTTP server on port 5299). Seeded users:
  `alice` (prefix `users/alice/`), `admin`, `frank`, `kate` (no passkey, no
  session), `gina`, a 32-char username; valid and expired invites; a folder
  tree under `users/alice/`.
- Passkey ceremonies run against a CDP virtual authenticator with RP ID
  `localhost` (secure context), matching development configuration.
- The live security-hardening checks (T068) run the e2e server on a scratch
  port with a file-backed database, a bootstrap admin configuration and
  lowered rate limits, exercised with `curl`.
- The chart was validated with `helm lint` and `helm template` (default and
  custom values) plus a `kubectl apply --dry-run=client` schema check and
  `scripts/verify-helm-hardening.sh`; no Kubernetes cluster is available in
  this environment, so nothing was deployed.

All commands below ran green on 2026-08-18. The e2e suite result: 55 passed.
Backend unit tests: 316 passed. Frontend unit tests: 38 passed. (Final
counts from the spec 005 Polish full pass, T067.)

## Scenario 1 - Token-gated first-passkey enrollment (bootstrap and invite)

The username-first bootstrap flow no longer exists: the sign-in page offers
only "Sign in with passkey" and the invite-link registration path, and
`register/options` / `register/verify` accept a secret token - never a
username (spec 005 FR-001/FR-002, US1).

Steps:

1. Deploy with `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME=admin`,
   `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET` / `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX`
   and `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN` (>= 16 chars) set.
2. Open `/register?token=<bootstrap enrollment token>` (the Register page
   serves both invite and bootstrap enrollment), complete the passkey
   prompt, land on the file browser for the configured bucket and prefix.
3. New users enroll the same way, via an invite link created by an admin;
   an invite whose username already exists attaches the passkey to that
   account when bucket/prefix/isAdmin match (spec 005 FR-004).

What was validated:

- Username-only `POST /auth/register/options {"username":"john"}` -> 400
  generic error and no options, identically for unknown and existing
  usernames (spec 005 SC-001/SC-002): backend tests in
  `backend/tests/routes-auth.test.ts` (T007/T008) and the live curl check
  in T068.
- Bootstrap enrollment: the correct token returns options carrying the
  admin's username/bucket/prefix; a wrong token returns the same generic
  `invite_not_found` refusal as an unknown invite token (never reveals a
  bootstrap token exists); the token is inert once the account has a
  passkey. Backend tests in `backend/tests/routes-auth.test.ts` (T009) and
  the live curl check in T068.
- Bootstrap admin provisioning from environment configuration is unit-tested
  in `backend/tests/bootstrap.test.ts` (provisions with the configured
  bucket and prefix, creates the account as admin by default, honours a
  non-admin flag, does not duplicate an existing username, allows an empty
  prefix). Run: `bun run test:backend`.
- First-passkey enrollment end-to-end: `e2e/auth.spec.ts` ("a seeded user
  enrolls via an invite link, signs in with a passkey and signs out") - the
  seeded user `alice` has no passkey, so enrollment goes through the seeded
  invite link (`invite-alice`) and attaches her first (discoverable) passkey
  to her existing account (spec 005 attach semantics). The same test then
  signs out and signs back in username-less: one "Sign in with passkey"
  click, zero keystrokes. Run: `bun run test:e2e`.
- The sign-in page renders no username input and no "First time? Use your
  username" fallback: frontend component test plus the responsive e2e
  assertions in `e2e/auth.spec.ts` ("sign-in page is usable at mobile,
  tablet and desktop widths").
- The chart wires the bootstrap variables into the deployment when set:
  `helm template prod deploy/helm/jivedrive -f <values>` rendered
  `JIVEDRIVE_BOOTSTRAP_ADMIN_*` entries in the ConfigMap, and the enrollment
  token is documented as a `secretConfig`-style override in
  `deploy/helm/jivedrive/README.md`.

Not validated here:

- A fresh cluster deployment with the bootstrap variables set. No cluster is
  available. At deploy time:

  ```bash
  helm install jivedrive deploy/helm/jivedrive --namespace jivedrive \
    --create-namespace --values prod-values.yaml
  ```

  with `jivedrive.config.JIVEDRIVE_BOOTSTRAP_ADMIN_*` and
  `jivedrive.secretConfig.JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN` set in
  `prod-values.yaml` (example in
  [`deploy/helm/jivedrive/README.md`](../deploy/helm/jivedrive/README.md)),
  then open the registration link for the provisioned admin at
  `https://drive.grimes.id.au/register?token=...`.

## Scenario 2 - Invite, register, browse, upload, share, delete

Steps and where each is exercised:

1. Admin creates an invite for `alice` with a bucket and prefix - the admin
   UI shows the 48-hour link and a pending row:
   `e2e/admin.spec.ts` ("an admin creates an invite and sees the 48-hour link
   and pending row"), plus `scripts/verify-admin.sh` (`create invite ->
   HTTP 201`, resend expiry 48 hours out).
2. Opening the invite link in a fresh context and registering a passkey signs
   the invitee in:
   `e2e/auth.spec.ts` ("an invitee registers a passkey from an invite link
   and signs in") and `e2e/admin.spec.ts` ("an invite created in the admin UI
   can be claimed by registering"). The invitee's space starts empty; the
   empty-listing behaviour is unit-tested in `backend/tests/routes-files.test.ts`
   ("returns an empty listing for an empty folder") and the seeded `empty/`
   folder exists in the e2e store.
3. Uploading a file shows progress and adds it to the listing:
   `e2e/upload.spec.ts` ("uploads a new file with progress feedback and shows
   it in the listing"); `scripts/verify-upload.sh` PUTs to a presigned URL and
   confirms the file appears in the listing.
4. Downloading a file returns the bytes: `e2e/browse.spec.ts` (download
   asserted byte-for-byte against the seed).
5. Sharing with the default 7-day expiry and downloading anonymously without
   a session: `e2e/share.spec.ts` ("the generated link downloads the file in
   a fresh context without a session") and `scripts/verify-share.sh`
   ("anonymous GET of the link downloads the file bytes", link carries
   `X-Amz-Expires=604800`).
6. Deleting after confirming empties the listing:
   `e2e/delete.spec.ts` ("confirming the delete removes the file from the
   listing") and `scripts/verify-delete.sh` (204, then 404 on re-delete).

Commands run:

```bash
bun run test:e2e
bash scripts/verify-admin.sh
bash scripts/verify-upload.sh
bash scripts/verify-share.sh
bash scripts/verify-delete.sh
```

## Scenario 3 - Overwrite protection

Steps:

1. Upload `report.pdf`.
2. Upload `report.pdf` again; the UI asks for confirmation and refuses
   without it; confirming replaces the object.

What was validated:

- `e2e/upload.spec.ts` ("uploading over an existing name asks for
  confirmation before replacing"): the second upload shows the confirm
  dialog; the object is replaced only after confirmation.
- `scripts/verify-upload.sh`: without `overwrite` the API returns
  `HTTP 409 {"error":"A file named \"report.pdf\" already exists",...}`;
  with `overwrite: true` it returns a presigned PUT URL for the same key.
- Backend contract: `backend/tests/routes-files.test.ts` ("returns 409 when
  the object exists and overwrite is not requested", "returns a presigned PUT
  URL when overwrite is confirmed").

Commands run:

```bash
bun run test:e2e
bash scripts/verify-upload.sh
```

## Scenario 4 - Invite expiry and user removal

Steps:

1. Create an invite and age it past 48 hours; the admin list shows it as
   expired; opening the link shows "invite expired".
2. Admin clicks "Re-send"; the new link works.
3. Admin removes `alice`; `alice` can no longer sign in; the objects under
   `users/alice/` remain in the bucket (verify in OVHcloud console).

What was validated:

- Expired invite handling: `e2e/auth.spec.ts` ("an expired invite is refused
  with a clear message") and `e2e/admin.spec.ts` ("an expired invite shows an
  expired status with a re-send option"); backend expiry logic in
  `backend/tests/routes-auth.test.ts` (refused expired/claimed invite) and
  `backend/tests/routes-admin.test.ts`.
- Re-send issues a fresh token and a new 48-hour expiry:
  `e2e/admin.spec.ts` ("re-sending an invite issues a fresh token and a new
  expiry") and `scripts/verify-admin.sh` (resend expiry 48 hours out, new
  link works).
- Removal: `e2e/admin.spec.ts` ("an admin removes a user and their session
  stops working") and `scripts/verify-admin.sh` (removed user gone from the
  list, session invalid, `storage untouched: alice's listing is unchanged
  after user removal`, last-admin and remove-self protections).

Not validated here:

- Verifying in the OVHcloud console that a removed user's objects remain.
  This environment uses a mock S3 store, and the mock has no persistence
  across runs. The storage-untouched behaviour is exercised against the mock
  (`verify-admin.sh` above). At deploy time, confirm the objects with the
  S3 CLI against the real bucket (bucket `jivedrive-prod`, prefix
  `users/alice/`):

  ```bash
  aws --endpoint-url https://s3.gra.io.cloud.ovh.net s3 ls \
    s3://jivedrive-prod/users/alice/ --recursive
  ```

  or inspect the bucket in the OVHcloud console.

## Scenario 5 - Scope isolation

Steps: with `alice` and `bob` on different prefixes, requests with keys
outside a user's prefix return 400 for list, download, upload, delete and
share. Spec 005 US6 additionally makes scope checks segment-aware: no key or
prefix may contain a `..` segment (FR-012).

What was validated:

- Unit tests in `backend/tests/routes-files.test.ts`: "rejects a prefix that
  escapes the user's space" (list), "rejects a key outside the user's prefix"
  (download, share, delete), "rejects a folder that escapes the user's space
  without touching storage" (upload), "rejects a key sharing only a name
  prefix" (delete).
- Spec 005 `..`-segment rejection: `normalizePrefix` and `assertKeyInScope`
  refuse `..` segments (invite creation, bootstrap config, listing, and
  every presign/head/delete call) in `backend/tests/db.test.ts`,
  `backend/tests/config.test.ts`, `backend/tests/s3.test.ts` and
  `backend/tests/routes-files.test.ts` (T053-T057).
- Curl scripts against the mock: `scripts/verify-upload.sh`
  (`folder escaping the user's space -> HTTP 400`), `scripts/verify-share.sh`
  (`key outside the user's space -> HTTP 400`), `scripts/verify-delete.sh`
  (`key outside the user's space -> HTTP 400`, `key sharing only a name
  prefix -> HTTP 400`).
- Scope enforcement lives in the route layer
  (`backend/src/routes/files.ts`) and is exercised by the tests above; the
  e2e suite uses single-prefix users, so cross-user isolation is covered at
  the API level rather than end-to-end.

Commands run:

```bash
bun run test:backend
bash scripts/verify-upload.sh
bash scripts/verify-share.sh
bash scripts/verify-delete.sh
```

## Scenario 6 - Admin passkey reset issues a re-enrollment invite and revokes sessions

Spec 005 US2: `DELETE /api/admin/users/{id}/passkeys` now returns
`200 {invite, link}` (previously 204). It deletes the user's credentials,
revokes **all** of the user's sessions (including the caller's own when
resetting self), cancels pending invites for the username, and creates a
fresh 48-hour re-enrollment invite carrying the user's own
bucket/prefix/isAdmin. The returned link is the only way back in - the
username-first flow no longer exists, so the reset never leaves an open
claimable window.

Steps:

1. Admin opens Admin users and resets the target user's passkeys.
2. The reset dialog surfaces a copyable re-enrollment link; the target's
   existing sessions stop working immediately.
3. The target opens the link and re-enrolls; the passkey attaches to the
   same account (no duplicate user, no re-scope).

What was validated:

- `e2e/admin.spec.ts` ("an admin resets a user's passkeys and the user
  re-enrolls via the returned reset link"): the dialog shows the link and
  the user re-enrolls through it.
- `scripts/verify-admin.sh` (`== Passkey reset ==`): reset -> HTTP 200 with
  `invite` pending and carrying the user's bucket/prefix and a `link`
  matching `http://localhost:5173/register?token=`; the user's old session
  is revoked (`/auth/me` with the captured cookie reports `user: null`); a
  fresh pending invite for the username appears in the admin list; the user
  re-enrolls via the returned link (attach flow: same username, matching
  scope, zero discoverable passkeys -> succeeds) and exactly one user row
  exists afterwards.
- Backend route tests in `backend/tests/routes-admin.test.ts` (T023-T027):
  credential deletion and full session revocation, self-reset revokes the
  caller's own session, unknown user -> 404 with nothing created, last-admin
  reset is allowed, other users' sessions untouched.
- Frontend: the admin reset flow surfaces and copies the returned link
  (`frontend/tests/` component tests, T028).

Commands run:

```bash
bun run test:e2e
bash scripts/verify-admin.sh
```

## Scenario 7 - Security hardening: headers, rate limiting, username-only refusal

Spec 005 US3/US4 quickstart checks, exercised live against the e2e server
(T068) and in the backend suite.

Steps:

1. `curl -sI` the SPA and `/healthcheck`; every response must carry the
   FR-009 header set and API/auth responses `Cache-Control: no-store`.
2. Fire rapid `POST /auth/login/options` requests past the configured limits
   and observe `429 {"error":...,"code":"rate_limited"}` with a
   `Retry-After` header.
3. POST `register/options` with only a username and observe a generic 400
   with no options, for both unknown and existing usernames.

What was validated:

- Backend header tests in `backend/tests/server.test.ts` (T040-T042): the
  full header set on SPA page, JSON 200, 401/404 and the error handler's
  500; `no-store` on `/api/*` and `/auth/*`; HSTS only in production.
  `e2e/auth.spec.ts` asserts a real page load carries the headers and the
  passkey ceremony still completes under the CSP.
- Backend rate-limit tests in `backend/tests/rateLimit.test.ts` and
  `backend/tests/routes-auth.test.ts` (T032-T037): burst then 429,
  refill over time, `/auth` vs `/api/files` family separation, identity
  extraction with/without a trusted proxy, 429 body + `Retry-After`, map
  pruning, and no challenge-state corruption on a 429.
- Live curl checks in T068 against the e2e server on a scratch port with
  lowered limits (`JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE=5`,
  `JIVEDRIVE_RATE_LIMIT_AUTH_BURST=3`): ~10 rapid `login/options` requests
  produce a 429 with `code: "rate_limited"` and `Retry-After`; headers on
  `/`, `/healthcheck` and API responses match FR-009/FR-010; username-only
  `register/options` returns the generic 400 for `john` and `admin` alike.
- Chart hardening: `scripts/verify-helm-hardening.sh` renders the chart with
  `helm template` and asserts `readOnlyRootFilesystem: true` (with `/data`
  writable and `/tmp` on an emptyDir), `allowPrivilegeEscalation: false`,
  `capabilities.drop: [ALL]`, seccomp `RuntimeDefault`, and non-empty
  resource requests/limits; the deploy workflow runs it before
  `helm upgrade` (T058/T059).

Commands run:

```bash
bun run test:backend
bun run test:e2e
bash scripts/verify-helm-hardening.sh
# live quickstart checks: e2e server with a bootstrap admin on a scratch
# port and lowered auth limits, exercised with curl (see T068)
```

## Chart validation (T055/T058, part of the quickstart "Validation" section)

`helm lint` and `helm template` succeed for the chart with default values:

```text
==> Linting deploy/helm/jivedrive
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
```

`helm template` renders with default values (Secret, ConfigMap, Service,
Deployment; no PVC - persistence disabled by default) and with custom values
(PVC enabled, custom image, resources, nodeSelector/tolerations/affinity,
bootstrap admin, real secret values, LoadBalancer service). Both renders pass
`kubectl apply --dry-run=client`. `scripts/verify-helm-hardening.sh` passes
against the rendered output. Commands:

```bash
export PATH="$PATH:$HOME/.local/bin"   # helm 3.19.1 installed user-local
helm lint deploy/helm/jivedrive
helm template jivedrive deploy/helm/jivedrive --namespace jivedrive
helm template prod deploy/helm/jivedrive --namespace jivedrive \
  --values /tmp/jivedrive-custom-values.yaml
helm template jivedrive deploy/helm/jivedrive --namespace jivedrive \
  | kubectl apply --dry-run=client -f -
bash scripts/verify-helm-hardening.sh
```

## Not validated here

- Scenario 4's OVHcloud console check (no real bucket; commands recorded
  above).
- A Helm deployment to a real Kubernetes cluster: no cluster is available,
  so spec 005 SC-008's pod-boot check (read-only rootfs with the DB on the
  PVC) is not exercised here; the rendered chart assertions are covered by
  `verify-helm-hardening.sh`. At deploy time, after building and pushing the
  image (`docker build -f docker/Dockerfile -t ghcr.io/johngrimes/jivedrive:0.1.0 .`),
  run:

  ```bash
  helm install jivedrive deploy/helm/jivedrive --namespace jivedrive \
    --create-namespace \
    --set jivedrive.persistence.enabled=true \
    --set jivedrive.secretConfig.JIVEDRIVE_S3_ACCESS_KEY_ID="<access key>" \
    --set jivedrive.secretConfig.JIVEDRIVE_S3_SECRET_ACCESS_KEY="<secret key>"
  ```

  then confirm the pod is ready (`kubectl -n jivedrive get pods`) and that
  `/healthcheck` returns `{"status":"ok"}` once an Ingress or port-forward
  exposes the service.
- Timing behaviour against real storage is not measured here; spec 005's
  SC-004 (rate limiting) and SC-002 (username-only refusal) are exercised
  live against the mock-backed e2e server in T068 and in the backend suite.

## Final full pass (T067)

```text
bun run test          -> 316 backend + 38 frontend tests pass
bun run lint          -> clean
bun run typecheck     -> clean
bun run format:check  -> clean
bun run test:e2e      -> 55 passed
helm lint             -> 0 failures
helm template         -> renders, passes kubectl client dry-run
scripts/verify-helm-hardening.sh -> all assertions pass
scripts/verify-admin.sh           -> all checks pass (incl. passkey reset)
```
## Feature 006 - Folder sharing (persistent user-to-user grants)

Spec
[`006-folder-sharing/quickstart.md`](../.local/specs/006-folder-sharing/quickstart.md)
adds persistent, revocable folder grants between users (FR-016/FR-017): an
owner shares a subfolder with a recipient via a searchable picker, the
recipient sees a mount labelled "Shared by \<owner\>" at their space root with
full read/write access, the owner can revoke at any time, and deleting a
user cascades their shares away (quickstart scenarios 1-5).

Environment:

- The e2e server now seeds a second non-admin user `bob` (prefix
  `users/bob/`, a root file and a same-named `projects` folder of his own,
  pre-seeded `bob-session` cookie) alongside the spec 005 seeds; alice's
  space gains a shareable `projects/` folder (`plan.txt`, `docs/report.pdf`).
- The curl validation boots the e2e server on a scratch port (5174) with a
  file-backed database (`JIVEDRIVE_PORT=5174 JIVEDRIVE_DB_PATH=...`), the
  same overrides `scripts/verify-share.sh` uses.
- Viewports: 375, 768 and 1280 px (constitution VI) via the responsive
  tests in `e2e/share-folder.spec.ts` and the existing
  `e2e/responsive.spec.ts`.

All commands below ran green on 2026-08-23. Final counts from the spec 006
Polish full pass (T039/T040): backend unit tests 388 passed, frontend unit
tests 71 passed, e2e 62 passed.

### Scenario 1 - Alice shares a folder with Bob

1. Sign in as alice and open the share dialog on `projects`:
   `e2e/share-folder.spec.ts` ("US1: alice shares the projects folder with
   bob via the share dialog").
2. Search `bo`: the picker returns `bob` as an identity-only result
   (FR-006) - the US1 e2e test, plus `scripts/verify-folder-share.sh`
   (`search q=bo returns bob`, `search result is identity-only`).
3. Select bob and confirm: `POST /api/shares` returns 201, the dialog
   lists bob with a share date, and the `projects` row shows the "Shared"
   chip (FR-018).
4. API check: `GET /api/shares` as alice returns `outgoing` with
   `folder: "projects/"` and `recipient.username: "bob"` (asserted in the
   US1 e2e test and in `verify-folder-share.sh`'s `list shows the outgoing
   share`).

Contract refusals covered by `scripts/verify-folder-share.sh`: duplicate
create 409 `already_shared`, self-share 400 `cannot_share_with_self`,
unknown recipient 404, space root 400 `invalid_folder`, unsigned requests
401. Unit coverage: `backend/tests/routes-shares.test.ts` (T013/T014) and
`backend/tests/routes-users.test.ts` (T015).

### Scenario 2 - Bob sees the mount and reads

1. Bob's root shows `projects` labelled "Shared by alice" alongside his own
   same-named folder (two rows, mount row labelled, no share button on the
   received row, FR-015): `e2e/share-folder.spec.ts` ("US2: bob browses and
   downloads the projects folder shared by alice").
2. Opening the mount lists the sharer's contents and `report.pdf` downloads
   byte-for-byte (`%PDF-1.4 report`); the breadcrumbs keep the mount name
   and the "Shared by alice" label: US2 e2e test, and
   `verify-folder-share.sh` (`bob lists the shared folder (plan.txt
   visible) before revocation`).
3. API check: `GET /api/files?space=shared:<shareId>&prefix=` lists the
   sharer's folder with mount-relative keys: the US2 e2e test's
   `space=shared` URL assertion, plus `backend/tests/scope.test.ts` (T005)
   and `backend/tests/routes-files.test.ts` (T007/T022).

### Scenario 3 - Bob writes to the shared folder

`e2e/share-folder.spec.ts` ("US3: bob uploads, overwrites and deletes a
file in the projects folder shared by alice"):

1. Bob uploads `notes.txt` into the mount (progress bar, then "Uploaded
   notes.txt"); it appears in the listing.
2. A second upload without consent is refused (409) and the confirmation
   dialog appears; Replace overwrites with the new content.
3. Deleting `notes.txt` removes it from the mount.
4. API check: alice's own `GET /api/files?prefix=projects&space=own` shows
   the same changes (single source of truth: the sharer's prefix) -
   asserted in the US3 e2e test. Upload/overwrite/delete in a shared space
   are unit-tested in `backend/tests/routes-files.test.ts` (T026).

### Scenario 4 - Revocation cuts access

1. Alice revokes bob's share in the dialog: `e2e/share-folder.spec.ts`
   ("US4: alice revokes bob's share; the mount disappears and every request
   404s") and `scripts/verify-folder-share.sh` (`alice revokes the share`
   HTTP 204).
2. Bob's next root load has no mount: US4 e2e test.
3. API check: bob's `GET /api/files?space=shared:<id>` returns 404
   (`verify-folder-share.sh`: `bob's shared space returns 404 after
   revocation`) and the share drops from alice's `outgoing` (`owner listing
   no longer shows the revoked share`). Opening the old shared URL as bob
   surfaces the explicit revocation message with Retry (US4 e2e test,
   T030). Revocation and re-share semantics are unit-tested in
   `backend/tests/routes-shares.test.ts` (T029) and
   `backend/tests/scope.test.ts` (T005).

### Scenario 5 - Account deletion cleans up shares

`e2e/share-folder.spec.ts` ("US5: admin deletes bob; alice's mount, share
dialog and /api/shares show no trace of bob"): the admin deletes bob;
alice's root shows no "Shared by bob" mount, her share dialog lists no
bob, and `GET /api/shares` shows no bob in either direction; bob's session
is gone (`/auth/me` reports `user: null`). The FK cascade (`ON DELETE
CASCADE` on both share FKs, enforced by `PRAGMA foreign_keys = ON`)
removes the rows with no manual cleanup; unit-tested in
`backend/tests/routes-admin.test.ts` (T032) and `backend/tests/db.test.ts`
(T003).

### Responsive coverage (constitution VI)

`e2e/share-folder.spec.ts` exercises the share flows at 375, 768 and
1280 px (T038):

- Alice's root with the share dialog open: no horizontal overflow; the
  search input and results list are usable (type `bo`, pick bob); the
  recipient row's revoke button keeps a 44px+ touch target (`min-h-11`).
- Bob's mount view with a subfolder: no horizontal overflow at the root and
  inside `docs/`; breadcrumbs carry the mount name and the "Shared by
  alice" label; upload/download/delete controls are present with 44px+
  touch targets; a real download of `report.pdf` works at 375 px.

Commands run:

```bash
bun run test                # 388 backend + 71 frontend tests pass
bun run test:e2e            # 62 passed (share-folder.spec.ts: 7 tests incl. the 3-width responsive sweep)
bash scripts/verify-folder-share.sh   # 15 PASS assertions, exit 0
bun run lint                # clean
bun run typecheck           # clean
bun run format:check        # clean
```

Not validated here (same environment limits as spec 005):

- Real OVHcloud Object Storage: shares resolve to S3 scopes against the
  in-memory mock, and presigned URLs are exercised through the mock HTTP
  server on port 5299. At deploy time the same flows run against the real
  bucket with no code change (the resolver only composes bucket/prefix).
- A Kubernetes deployment: unchanged from spec 005; this feature adds no
  runtime configuration.
