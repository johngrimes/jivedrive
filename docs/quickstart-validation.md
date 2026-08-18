# Quickstart validation

Validation of the scenarios in
[`.local/specs/001-ovhcloud-file-browser/quickstart.md`](../.local/specs/001-ovhcloud-file-browser/quickstart.md)
against a local instance with a mock S3 layer and a seeded database, plus
chart validation for the deployment path.

## Environment and method

- Commit: `7365a10` (working tree) - see `git log`.
- Local instance: the e2e server (`backend/src/e2eServer.ts`) serves the built
  SPA and the API on port 5173 with an in-memory SQLite database and an
  in-memory mock S3 store (mock S3 HTTP server on port 5299). Seeded users:
  `alice` (prefix `users/alice/`), `admin`, `frank`; valid and expired
  invites; a folder tree under `users/alice/`.
- Passkey ceremonies run against a CDP virtual authenticator with RP ID
  `localhost` (secure context), matching development configuration.
- The chart was validated with `helm lint` and `helm template` (default and
  custom values) plus a `kubectl apply --dry-run=client` schema check; no
  Kubernetes cluster is available in this environment, so nothing was
  deployed.

All commands below ran green on 2026-08-12. The e2e suite result: 21 passed.
Backend unit tests: 228 passed across 12 files. Frontend unit tests: 35
passed across 3 files.

## Scenario 1 - Bootstrap and first sign-in

Steps:

1. Deploy with `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME=admin` and
   `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET` / `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX`
   set.
2. Open the site, click "First time? Use your username", enter `admin`,
   complete the passkey prompt, land on the file browser for the configured
   bucket and prefix.

What was validated:

- Bootstrap admin provisioning from environment configuration is unit-tested
  in `backend/tests/bootstrap.test.ts` (provisions with the configured bucket
  and prefix, creates the account as admin by default, honours a non-admin
  flag, does not duplicate an existing username, allows an empty prefix).
  Run: `bun run test:backend`.
- The chart wires the bootstrap variables into the deployment when set:
  `helm template prod deploy/helm/jivedrive -f <values>` rendered
  `JIVEDRIVE_BOOTSTRAP_ADMIN_*` entries in the ConfigMap.
- First sign-in via the username fallback form (first-passkey bootstrap) is
  covered end-to-end by `e2e/auth.spec.ts` ("a seeded user signs in with a
  passkey and signs out"): the seeded user has no passkey, so the first
  sign-in reveals the fallback form, registers the first (discoverable)
  passkey and lands on `/files` for the user's bucket and prefix. The same
  test then signs out and signs back in username-less: one "Sign in with
  passkey" click, zero keystrokes. Run: `bun run test:e2e`.

Not validated here:

- A fresh cluster deployment with the bootstrap variables set (SC-005). No
  cluster is available. At deploy time:

  ```bash
  helm install jivedrive deploy/helm/jivedrive --namespace jivedrive \
    --create-namespace --values prod-values.yaml
  ```

  with `jivedrive.config.JIVEDRIVE_BOOTSTRAP_ADMIN_*` set in
  `prod-values.yaml` (example in
  [`deploy/helm/jivedrive/README.md`](../deploy/helm/jivedrive/README.md)),
  then sign in at `https://drive.grimes.id.au`.

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
share.

What was validated:

- Unit tests in `backend/tests/routes-files.test.ts`: "rejects a prefix that
  escapes the user's space" (list), "rejects a key outside the user's prefix"
  (download, share, delete), "rejects a folder that escapes the user's space
  without touching storage" (upload), "rejects a key sharing only a name
  prefix" (delete).
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

## Chart validation (T055, part of the quickstart "Validation" section)

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
`kubectl apply --dry-run=client`. Commands:

```bash
export PATH="$PATH:$HOME/.local/bin"   # helm 3.19.1 installed user-local
helm lint deploy/helm/jivedrive
helm template jivedrive deploy/helm/jivedrive --namespace jivedrive
helm template prod deploy/helm/jivedrive --namespace jivedrive \
  --values /tmp/jivedrive-custom-values.yaml
helm template jivedrive deploy/helm/jivedrive --namespace jivedrive \
  | kubectl apply --dry-run=client -f -
```

## Not validated here

- Scenario 4's OVHcloud console check (no real bucket; commands recorded
  above).
- SC-005: a Helm deployment to a real Kubernetes cluster. No cluster is
  available. At deploy time, after building and pushing the image
  (`docker build -f docker/Dockerfile -t ghcr.io/johngrimes/jivedrive:0.1.0 .`),
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
- SC-001, SC-002 and SC-004 (timing behaviour against real storage) are not
  measured here; SC-003 and SC-004's link behaviour are exercised by the e2e
  suite above.

## Final full pass (T058)

```text
bun run test          -> 228 backend + 35 frontend tests pass
bun run lint          -> clean
bun run typecheck     -> clean
bun run format:check  -> clean
bun run test:e2e      -> 21 passed (5.7s)
helm lint             -> 0 failures
helm template         -> renders, passes kubectl client dry-run
```
