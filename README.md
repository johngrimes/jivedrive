# JiveDrive

JiveDrive is a small, passkey-authenticated file browser for
[OVHcloud Object Storage](https://www.ovhcloud.com/en/public-cloud/object-storage/).
Each user is scoped to an admin-configured bucket and prefix, and can browse
and create folders, download, upload one or more files at a time (with
overwrite confirmation), move files between folders, generate short share
links, and delete files. Admins invite users and manage accounts.
Authentication is WebAuthn passkeys only - no passwords.

- SPA + REST API in one container (React + Vite frontend, Hono backend, bun).
- SQLite database (users, passkey credentials, invites, sessions) on a
  Kubernetes PVC; object storage over the S3 API.
- Deployable on Kubernetes via the Helm chart in
  [`deploy/helm/jivedrive/`](deploy/helm/jivedrive/).
- Persistent user-to-user folder sharing: full read/write access to a
  folder, mounts labelled with the sharer, revocable at any time.
- Short share links: an anonymous `<origin>/s/<12-character token>` link
  to a single file, valid for 1 hour to 30 days, stored only until expiry.
- Moving files: a file can be moved to another existing folder of the same
  space (its own space, or within a shared folder) from the listing or a
  search result. A name clash at the destination is refused, never
  overwritten. The move is a server-side copy then delete; the file's
  short share links keep working and its search entry follows it.
- Full-text search: one search box finds folders by name and files by name
  and by content (plain text, PDF, DOCX) across the user's space and every
  folder shared with them, kept fresh by a background index scan.

## Local development

### Prerequisites

- [bun](https://bun.sh) 1.3.x
- Node.js 20+ (for Playwright's browser downloads)
- An OVHcloud Object Storage bucket with S3 credentials, or the built-in mock
  S3 (see below)

### Install and run

```bash
bun install
overmind start
```

[overmind](https://github.com/DarthSim/overmind) launches the processes listed
in the `Procfile`: the backend on `http://localhost:3000` and the Vite dev
server on `http://localhost:5173`. The Vite server proxies `/api`, `/auth` and
`/healthcheck` to the backend (see `frontend/vite.config.ts`), so browse to
`http://localhost:5173`. Use `overmind start web` or `overmind start api` to
run a single process, and `overmind open` to open the web process in your
browser.

The backend requires S3 credentials even in development. Create
`backend/.env` (gitignored; bun loads it automatically):

```bash
# backend/.env
JIVEDRIVE_S3_ENDPOINT=https://s3.gra.io.cloud.ovh.net
JIVEDRIVE_S3_REGION=gra
JIVEDRIVE_S3_ACCESS_KEY_ID=your-access-key
JIVEDRIVE_S3_SECRET_ACCESS_KEY=your-secret-key
```

Optionally provision a bootstrap admin on first start:

```bash
JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME=admin
JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET=jivedrive-prod
JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX=users/admin/
```

### Demo without OVHcloud credentials

The e2e server (`backend/src/e2eServer.ts`) serves the built SPA on port 5173
with an in-memory database and an in-memory mock S3 store, seeded with users
(`alice`, `admin`), invites and files. It is what the Playwright suite runs
against:

```bash
bun run --cwd frontend build
bun run backend/src/e2eServer.ts
```

Then open `http://localhost:5173`. Passkey ceremonies run through your
browser; on headless machines use the Playwright suite instead.

## Configuration

All configuration is via `JIVEDRIVE_*` environment variables, parsed and
validated by `backend/src/config.ts`. Required variables cause a startup
error listing every problem when missing or invalid.

| Variable                                 | Default                 | Required          | Description                                                                     |
| ---------------------------------------- | ----------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `JIVEDRIVE_PORT`                         | `3000`                  | no                | HTTP port the server listens on                                                 |
| `JIVEDRIVE_DB_PATH`                      | `jivedrive.db`          | no                | SQLite database file path                                                       |
| `JIVEDRIVE_MIGRATIONS_DIR`               | `<cwd>/migrations`      | no                | Directory of SQL migration files, applied at startup                            |
| `JIVEDRIVE_SESSION_TTL_DAYS`             | `30`                    | no                | Session lifetime in days                                                        |
| `JIVEDRIVE_S3_ENDPOINT`                  | -                       | yes               | OVHcloud Object Storage S3 endpoint URL, e.g. `https://s3.gra.io.cloud.ovh.net` |
| `JIVEDRIVE_S3_REGION`                    | `gra`                   | no                | OVHcloud region                                                                 |
| `JIVEDRIVE_S3_ACCESS_KEY_ID`             | -                       | yes               | S3 access key id (secret)                                                       |
| `JIVEDRIVE_S3_SECRET_ACCESS_KEY`         | -                       | yes               | S3 secret access key (secret)                                                   |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME`     | unset                   | no                | Provision this username as the bootstrap admin at first start                   |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET`       | unset                   | when username set | Bucket for the bootstrap admin                                                  |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX`       | unset                   | no                | Prefix for the bootstrap admin (normalised to end with `/`)                     |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN`     | `true`                  | no                | Whether the bootstrap account is an admin                                       |
| `JIVEDRIVE_WEBAUTHN_RP_ID`               | `localhost`             | in production     | WebAuthn relying party id                                                       |
| `JIVEDRIVE_WEBAUTHN_ORIGIN`              | `http://localhost:5173` | in production     | WebAuthn relying party origin (must be https in production)                     |
| `JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS` | `3600`                  | no                | Seconds between background search-index scans of each user's space              |
| `JIVEDRIVE_SEARCH_INDEX_MAX_BYTES`       | `10485760`              | no                | Maximum object size (bytes) eligible for search content extraction (10 MiB)     |

## Passkey setup

JiveDrive authenticates with platform passkeys (WebAuthn), username-less:
sign-in is a single "Sign in with passkey" click using discoverable
credentials, with no text entry. A "First time? Use your username" fallback
form creates the first passkey for accounts that have none (bootstrap admin,
seeded users, or after an admin resets passkeys).
Two settings must match what the browser sees:

- `JIVEDRIVE_WEBAUTHN_RP_ID` is the relying party id: the registrable domain
  of the site. In production this is `drive.grimes.id.au`; in development it
  is `localhost`.
- `JIVEDRIVE_WEBAUTHN_ORIGIN` is the exact origin users sign in from:
  `https://drive.grimes.id.au` in production, `http://localhost:5173` in
  development.

WebAuthn only works in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
`https` (or `http://localhost`). If the origin differs from what the browser
sees, the passkey ceremony fails, so terminate TLS in front of the app at the
configured origin before deploying. Passkey management (adding, removing,
backing up credentials) is delegated to the platform - a lost passkey is
recovered by having an admin reset the user's passkeys (Admin users page),
after which the user re-enrolls via the "First time? Use your username"
form.

## Search

The Files page has a search box that replaces the folder listing with a
flat result list. Folder and file names are matched case-insensitively by
substring across the user's entire space (a folder matches on its own
name, not on its parent folders); content is matched against extracted
text from plain text, PDF, and DOCX files. Folder matches rank first, then
filename matches, then content matches; content matches show a snippet
with the matching text, and the list is capped at 50 results. Clicking a
folder result opens that folder, and own-space folder results can be
shared from the list. Queries shorter than three characters fall back to
name-only matching.

Search covers every folder shared with the user in the same query; results
from a shared mount are labelled with the sharer's username, and revoking
a share removes its results immediately. Files above
`JIVEDRIVE_SEARCH_INDEX_MAX_BYTES` and files whose text cannot be
extracted (corrupt or password-protected documents, other formats) remain
findable by name only.

The search index is a trigram FTS5 table in the existing SQLite database,
plus a folder table, kept fresh by a background scan of each user's space
every `JIVEDRIVE_SEARCH_SCAN_INTERVAL_SECONDS`: new objects are indexed,
objects whose ETag or size changed are re-extracted, and rows for deleted
objects are removed. The same scan records every folder in the space —
each object's parent folders and any empty-folder placeholder objects — so
empty folders are searchable too. Unchanged objects are never
re-downloaded, so scans of stable spaces are cheap. An admin can force an
immediate reconciliation for any user from the Admin users page ("Rebuild
search index"), which reports how many objects were indexed, re-extracted,
and removed.

## Deployment

The app deploys to Kubernetes as a single replica (SQLite-backed) via the
Helm chart in `deploy/helm/jivedrive/`. The chart creates a Deployment
(`Recreate` strategy), a Service, an optional PVC for the database, a
ConfigMap for non-secret configuration, and a Secret for S3 credentials. It
creates no Ingress; expose the Service with your own Ingress at
`https://drive.grimes.id.au`.

### Bucket setup (once per bucket)

Uploads PUT files directly from the browser to the OVHcloud S3 endpoint
(FR-008), so the bucket needs a CORS policy allowing the app origin.
Without it, production uploads fail with a browser CORS error and no server
log. In the OVHcloud console, set the bucket CORS policy to:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <CORSRule>
    <AllowedOrigin>https://drive.grimes.id.au</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>Content-Type</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Use `http://localhost:5173` as the origin in development. (The e2e mock S3
server applies an equivalent policy itself.)

### 1. Build and push the image

On push to `main`, the CI workflow
([`.github/workflows/quality-and-deploy.yml`](.github/workflows/quality-and-deploy.yml))
builds the image and publishes `ghcr.io/johngrimes/jivedrive:sha-<commit>`
plus `:latest`, then deploys the chart to the minikube cluster. To publish
manually (e.g. before CI is set up):

```bash
docker build -f docker/Dockerfile -t ghcr.io/johngrimes/jivedrive:0.1.0 .
docker push ghcr.io/johngrimes/jivedrive:0.1.0
```

### 2. Install the chart

```bash
helm install jivedrive deploy/helm/jivedrive \
  --namespace jivedrive --create-namespace \
  --set jivedrive.persistence.enabled=true \
  --set jivedrive.secretConfig.JIVEDRIVE_S3_ACCESS_KEY_ID="<access key>" \
  --set jivedrive.secretConfig.JIVEDRIVE_S3_SECRET_ACCESS_KEY="<secret key>"
```

For more than the defaults (bootstrap admin, custom image, resources), use a
values file; see the [chart README](deploy/helm/jivedrive/README.md) for the
complete configuration reference and examples.

### 3. First sign-in

Sign in at `https://drive.grimes.id.au` with a single "Sign in with passkey"
click. On first sign-in an account has no passkey yet, so click "First time?
Use your username" and enter your username (the bootstrap admin's, or a user
invited by an admin) to create the first passkey; subsequent sign-ins are
username-less.

## Testing

```bash
bun run test          # backend + frontend unit and integration tests
bun run test:e2e      # Playwright end-to-end suite (mock S3, seeded DB)
bun run lint          # ESLint
bun run typecheck     # tsc on backend and frontend
bun run format:check  # Prettier
```

The e2e suite builds the SPA and runs it against `backend/src/e2eServer.ts`
with a virtual WebAuthn authenticator (CDP), so no real passkey device or
OVHcloud credentials are needed. The scripts in `scripts/` verify individual
API flows with curl against the same server. Quickstart scenario validation
results are recorded in [`docs/quickstart-validation.md`](docs/quickstart-validation.md).

## Repository layout

```text
backend/     Hono API, SQLite data layer, WebAuthn, S3 wrapper, migrations
frontend/    React + Vite SPA
e2e/         Playwright end-to-end tests
docker/      Multi-stage Dockerfile
deploy/      Helm chart
docs/        Validation and operations documentation
scripts/     curl-based verification scripts
```

Copyright © 2026, John Grimes.
