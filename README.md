# JiveDrive

JiveDrive is a small, passkey-authenticated file browser for
[OVHcloud Object Storage](https://www.ovhcloud.com/en/public-cloud/object-storage/).
Each user is scoped to an admin-configured bucket and prefix, and can browse
folders, download, upload (with overwrite confirmation), generate
fire-and-forget share links, and delete files. Admins invite users and manage
accounts. Authentication is WebAuthn passkeys only - no passwords.

- SPA + REST API in one container (React + Vite frontend, Hono backend, bun).
- SQLite database (users, passkey credentials, invites, sessions) on a
  Kubernetes PVC; object storage over the S3 API.
- Deployable on Kubernetes via the Helm chart in
  [`deploy/helm/jivedrive/`](deploy/helm/jivedrive/).

## Local development

### Prerequisites

- [bun](https://bun.sh) 1.3.x
- Node.js 20+ (for Playwright's browser downloads)
- An OVHcloud Object Storage bucket with S3 credentials, or the built-in mock
  S3 (see below)

### Install and run

```bash
bun install
bun run dev
```

This starts the backend on `http://localhost:3000` and the Vite dev server on
`http://localhost:5173`. The Vite server proxies `/api`, `/auth` and
`/healthcheck` to the backend (see `frontend/vite.config.ts`), so browse to
`http://localhost:5173`.

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

| Variable                             | Default                 | Required          | Description                                                                     |
| ------------------------------------ | ----------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `JIVEDRIVE_PORT`                     | `3000`                  | no                | HTTP port the server listens on                                                 |
| `JIVEDRIVE_DB_PATH`                  | `jivedrive.db`          | no                | SQLite database file path                                                       |
| `JIVEDRIVE_MIGRATIONS_DIR`           | `<cwd>/migrations`      | no                | Directory of SQL migration files, applied at startup                            |
| `JIVEDRIVE_SESSION_TTL_DAYS`         | `30`                    | no                | Session lifetime in days                                                        |
| `JIVEDRIVE_S3_ENDPOINT`              | -                       | yes               | OVHcloud Object Storage S3 endpoint URL, e.g. `https://s3.gra.io.cloud.ovh.net` |
| `JIVEDRIVE_S3_REGION`                | `gra`                   | no                | OVHcloud region                                                                 |
| `JIVEDRIVE_S3_ACCESS_KEY_ID`         | -                       | yes               | S3 access key id (secret)                                                       |
| `JIVEDRIVE_S3_SECRET_ACCESS_KEY`     | -                       | yes               | S3 secret access key (secret)                                                   |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` | unset                   | no                | Provision this username as the bootstrap admin at first start                   |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET`   | unset                   | when username set | Bucket for the bootstrap admin                                                  |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX`   | unset                   | no                | Prefix for the bootstrap admin (normalised to end with `/`)                     |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN` | `true`                  | no                | Whether the bootstrap account is an admin                                       |
| `JIVEDRIVE_WEBAUTHN_RP_ID`           | `localhost`             | in production     | WebAuthn relying party id                                                       |
| `JIVEDRIVE_WEBAUTHN_ORIGIN`          | `http://localhost:5173` | in production     | WebAuthn relying party origin (must be https in production)                     |

## Passkey setup

JiveDrive authenticates with platform passkeys (WebAuthn), username-first.
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
recovered by having an admin remove and re-invite the user.

## Deployment

The app deploys to Kubernetes as a single replica (SQLite-backed) via the
Helm chart in `deploy/helm/jivedrive/`. The chart creates a Deployment
(`Recreate` strategy), a Service, an optional PVC for the database, a
ConfigMap for non-secret configuration, and a Secret for S3 credentials. It
creates no Ingress; expose the Service with your own Ingress at
`https://drive.grimes.id.au`.

### 1. Build and push the image

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

Sign in at `https://drive.grimes.id.au` with the bootstrap admin username, or
with a user invited by an admin. The first sign-in registers the passkey.

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
