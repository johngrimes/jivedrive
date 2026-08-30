# jivedrive

## Introduction

The `jivedrive` chart deploys [JiveDrive](https://drive.grimes.id.au), a
passkey-authenticated file browser for OVHcloud Object Storage, as a single
container serving both the web UI and the REST API. The app stores its SQLite
database (users, passkey credentials, invites, sessions) on a persistent
volume, while files themselves live in OVHcloud Object Storage and are
accessed over the S3 API.

## Features

- Single-replica deployment with a `Recreate` strategy (the app is
  SQLite-backed and single-writer).
- Persistent SQLite database on a PVC, disabled by default (an emptyDir is
  mounted instead, so data is ephemeral until persistence is enabled).
- Health probes: startup, liveness and readiness, all against
  `/healthcheck`.
- Non-sensitive configuration passed via a ConfigMap; S3 credentials passed
  via a Kubernetes Secret (`secretConfig`).
- Runs as a non-root user (the image's `bun` user, UID 1000).
- Hardened container defaults: read-only root filesystem with the SQLite
  volume writable at `/data` (plus an `emptyDir` mounted at `/tmp` for
  scratch files), no privilege escalation, all Linux capabilities dropped,
  seccomp `RuntimeDefault`, and default resource requests/limits (see
  [Security hardening](#security-hardening)).
- Automated CI: on push to `main`, the workflow in
  `.github/workflows/quality-and-deploy.yml` runs the quality gates, builds
  and publishes the image to GHCR, and deploys the chart to the minikube
  cluster with `values-ci.yaml` (image tag and S3 credentials passed as
  `--set` from GitHub secrets). The deploy job verifies the hardened
  rendering with `scripts/verify-helm-hardening.sh` before upgrading.

## Prerequisites

- Kubernetes 1.21+ (the deployment uses `apps/v1`, PVCs and standard
  probe fields).
- Helm 3.x.
- A container image of the JiveDrive server (see
  [Installation](#installation)). The CI workflow publishes
  `ghcr.io/johngrimes/jivedrive` automatically on push to `main`; before
  that, build and push it manually as shown below.
- An OVHcloud Object Storage bucket and S3 credentials (access key id and
  secret access key).
- A bucket CORS policy allowing the app origin: uploads PUT files directly
  from the browser to the S3 endpoint (FR-008), so the bucket must allow
  `PUT` and `Content-Type` from the app origin (default
  `https://drive.grimes.id.au`; use `http://localhost:5173` in development).
  See the CORS policy in the root [README](../README.md) "Bucket setup".
- A domain whose TLS is terminated in front of the service. This chart
  intentionally creates no Ingress; for the WebAuthn relying party to work,
  the app must be reachable at the origin configured via
  `jivedrive.config.JIVEDRIVE_WEBAUTHN_ORIGIN` (default
  `https://drive.grimes.id.au`).

## Installation

### 1. Build and publish the image

On push to `main`, the CI workflow
(`.github/workflows/quality-and-deploy.yml`) builds the image from
`docker/Dockerfile` and pushes `ghcr.io/johngrimes/jivedrive:sha-<commit>`
plus `:latest`. For a local cluster (or to publish outside CI), build and
push from the repository root, then point `jivedrive.image` at it:

```bash
docker build -f docker/Dockerfile -t ghcr.io/johngrimes/jivedrive:0.1.0 .
docker push ghcr.io/johngrimes/jivedrive:0.1.0
```

When the image lives in a private registry (the GHCR package for this
repository is private), the cluster needs a pull secret and the chart must
reference it via `jivedrive.image.pullSecret`:

```bash
kubectl create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username="<github-user>" \
  --docker-password="<classic PAT with read:packages>"
```

Use a classic PAT: GitHub Packages authentication only supports classic
personal access tokens (fine-grained tokens cannot authenticate to the
registries, even with the Packages permission).

The CI workflow does this automatically on push to `main` (it creates the
`ghcr-pull` secret from the `GHCR_PULL_USERNAME` / `GHCR_PULL_TOKEN`
repository secrets; see `values-ci.yaml`).

### 2. Install the chart

Provide the required S3 credentials and enable persistent storage. You can
pass values with `--set`:

```bash
helm install jivedrive deploy/helm/jivedrive \
  --namespace jivedrive --create-namespace \
  --set jivedrive.persistence.enabled=true \
  --set jivedrive.secretConfig.JIVEDRIVE_S3_ACCESS_KEY_ID="<access key>" \
  --set jivedrive.secretConfig.JIVEDRIVE_S3_SECRET_ACCESS_KEY="<secret key>"
```

or with a values file (recommended for non-secret settings, e.g. the
bootstrap admin):

```bash
helm install jivedrive deploy/helm/jivedrive \
  --namespace jivedrive --create-namespace \
  --values /path/to/my-values.yaml
```

The CI workflow deploys to minikube with
`deploy/helm/jivedrive/values-ci.yaml` (persistence enabled, image from
GHCR) plus `--set` overrides for the image tag and S3 credentials; see
`.github/workflows/quality-and-deploy.yml` for the exact command.

### 3. First sign-in

Enrollment is token-gated: a username alone never registers an account. If
you configured a bootstrap admin (see [Examples](#examples)), set
`JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN` (a secret, so put it in
`jivedrive.secretConfig`), then open the registration link carrying that
token — `https://drive.grimes.id.au/register?token=<token>` — and complete
the passkey prompt. This registers the account's first (discoverable)
passkey; subsequent sign-ins are username-less with a single "Sign in with
passkey" click. New users enroll the same way, through an invite link
created by an admin (see [Passkey reset](#passkey-reset)). Otherwise, the
first admin must be created from inside the cluster (for example with a
one-off `kubectl exec` against the database).

## Configuration

All values live under the `jivedrive` top-level key. Values are grouped as
`config` (non-sensitive, rendered into a ConfigMap) and `secretConfig`
(sensitive, rendered into a Secret); the deployment reads both via
`envFrom`.

### Configuration table

| Parameter | Description | Default |
| --------- | ----------- | ------- |
| `jivedrive.image.repository` | Container image repository | `ghcr.io/johngrimes/jivedrive` |
| `jivedrive.image.tag` | Container image tag | `0.1.0` |
| `jivedrive.image.pullPolicy` | Image pull policy | `Always` |
| `jivedrive.image.pullSecret` | Name of an existing `kubernetes.io/dockerconfigjson` Secret for pulling the image from a private registry; empty means no `imagePullSecrets` | `""` (none) |
| `jivedrive.replicas` | Number of replicas; keep at `1` (SQLite, single-writer) | `1` |
| `jivedrive.resources.requests.memory` | Memory request for the server container | `256Mi` |
| `jivedrive.resources.requests.cpu` | CPU request for the server container | `100m` |
| `jivedrive.resources.limits.memory` | Memory limit for the server container | `1Gi` |
| `jivedrive.resources.limits.cpu` | CPU limit for the server container | `500m` |
| `jivedrive.nodeSelector` | Node selector for pod scheduling | `{}` |
| `jivedrive.tolerations` | Tolerations for pod scheduling | `[]` |
| `jivedrive.affinity` | Affinity rules for pod scheduling | `{}` |
| `jivedrive.config` | Map of non-sensitive `JIVEDRIVE_*` environment variables | see below |
| `jivedrive.secretConfig` | Map of sensitive `JIVEDRIVE_*` environment variables (S3 credentials) | empty keys |
| `jivedrive.service.type` | Kubernetes Service type | `ClusterIP` |
| `jivedrive.service.port` | Service port | `80` |
| `jivedrive.persistence.enabled` | Mount a PVC for the SQLite database | `false` |
| `jivedrive.persistence.size` | PVC size when enabled | `5Gi` |
| `jivedrive.persistence.mountPath` | Mount path for the database volume | `/data` |
| `jivedrive.persistence.storageClassName` | Storage class for the PVC | unset (cluster default) |

### Environment variables

The following `JIVEDRIVE_*` variables are read by the backend
(`backend/src/config.ts`). Non-secret variables belong in `jivedrive.config`;
secrets belong in `jivedrive.secretConfig`. Defaults below match the backend's
defaults, except where the chart defaults to the production deployment
(`drive.grimes.id.au`, OVHcloud SGP).

| Variable | Description | Chart default |
| -------- | ----------- | ------------- |
| `JIVEDRIVE_PORT` | HTTP port the server listens on; must match the container port `3000` in the deployment template | `3000` |
| `JIVEDRIVE_DB_PATH` | SQLite database file path; keep it under `jivedrive.persistence.mountPath` | `/data/jivedrive.db` |
| `JIVEDRIVE_MIGRATIONS_DIR` | Directory of SQL migration files (baked into the image) | `/app/migrations` |
| `JIVEDRIVE_SESSION_TTL_DAYS` | Session lifetime in days | `30` |
| `JIVEDRIVE_SESSION_IDLE_DAYS` | Sessions expire after this many days of inactivity (rolling); the absolute `JIVEDRIVE_SESSION_TTL_DAYS` still caps them | `7` |
| `JIVEDRIVE_RATE_LIMIT_AUTH_PER_MINUTE` | Token-bucket refill per minute for `/auth/*` | `20` |
| `JIVEDRIVE_RATE_LIMIT_AUTH_BURST` | Token-bucket burst capacity for `/auth/*` | `10` |
| `JIVEDRIVE_RATE_LIMIT_FILES_PER_MINUTE` | Token-bucket refill per minute for `/api/files/*` | `300` |
| `JIVEDRIVE_RATE_LIMIT_FILES_BURST` | Token-bucket burst capacity for `/api/files/*` | `100` |
| `JIVEDRIVE_TRUST_PROXY` | Trust the TLS terminator's `X-Forwarded-For` header for rate-limit client identity (the backend itself defaults to `false`) | `true` (chart) |
| `JIVEDRIVE_S3_ENDPOINT` | OVHcloud Object Storage S3 endpoint URL | `https://s3.sgp.io.cloud.ovh.net` |
| `JIVEDRIVE_S3_REGION` | OVHcloud region | `sgp` |
| `JIVEDRIVE_S3_ACCESS_KEY_ID` | S3 access key id (secret; required) | `""` |
| `JIVEDRIVE_S3_SECRET_ACCESS_KEY` | S3 secret access key (secret; required) | `""` |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` | Bootstrap admin username, provisioned at first start (optional) | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET` | Bucket for the bootstrap admin (required when a username is set) | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX` | Prefix for the bootstrap admin | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN` | Whether the bootstrap account is an admin (`true`/`false`) | `true` |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN` | Bootstrap admin enrollment token. A secret: put it in `jivedrive.secretConfig`, not `jivedrive.config`. REQUIRED (at least 16 characters) whenever `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` is set; enroll the admin by opening `/register?token=<token>` | unset (none) |
| `JIVEDRIVE_WEBAUTHN_RP_ID` | WebAuthn relying party id; must match the site's registrable domain | `drive.grimes.id.au` |
| `JIVEDRIVE_WEBAUTHN_ORIGIN` | WebAuthn relying party origin; must be the https origin users sign in from | `https://drive.grimes.id.au` |

The app refuses to start when `JIVEDRIVE_S3_ACCESS_KEY_ID` or
`JIVEDRIVE_S3_SECRET_ACCESS_KEY` is missing, and in production
(`NODE_ENV=production`, set by the image) when the WebAuthn variables are
missing or not https.

### Security hardening

The deployment renders a hardened container by default (asserted in CI by
`scripts/verify-helm-hardening.sh` before every deploy):

- `readOnlyRootFilesystem: true` — the app writes only to the SQLite
  database on `/data`; the root filesystem is read-only so a compromised
  process cannot modify the image.
- `/data` stays writable via the PVC mount (or the ephemeral `emptyDir`
  when `jivedrive.persistence.enabled` is `false`).
- A separate `emptyDir` is mounted at `/tmp` for runtime scratch files
  (e.g. Bun temp files), so the read-only rootfs does not break startup.
- `allowPrivilegeEscalation: false`, all capabilities dropped
  (`capabilities.drop: [ALL]`), and seccomp `RuntimeDefault`.
- The pod-level `securityContext` keeps `runAsNonRoot: true` and
  `fsGroup: 1000`, so the pod still runs as the non-root `bun` user.
- Default resource requests (`100m` CPU, `256Mi` memory) and limits
  (`500m` CPU, `1Gi` memory); override via `jivedrive.resources`.

### Passkey reset

The admin "reset passkeys" action (on the admin users page) deletes the
user's passkeys, revokes **all** of that user's sessions immediately, and
returns a fresh 48-hour re-enrollment invite link. The user opens the link
to register a new passkey through the same token-gated flow as first
enrollment — the account is never left claimable by a username alone, and
the user's old sessions stop working the moment the reset completes.

## Examples

### Production: persistent storage, bootstrap admin, custom image

```yaml
jivedrive:
  image:
    repository: "registry.example.com/jivedrive"
    tag: "1.2.3"
    pullPolicy: "IfNotPresent"

  config:
    JIVEDRIVE_S3_ENDPOINT: "https://s3.sgp.io.cloud.ovh.net"
    JIVEDRIVE_S3_REGION: "sgp"
    JIVEDRIVE_WEBAUTHN_RP_ID: "drive.grimes.id.au"
    JIVEDRIVE_WEBAUTHN_ORIGIN: "https://drive.grimes.id.au"
    JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin"
    JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod"
    JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "users/admin/"
    JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN: "true"

  secretConfig:
    JIVEDRIVE_S3_ACCESS_KEY_ID: "<access key>"
    JIVEDRIVE_S3_SECRET_ACCESS_KEY: "<secret key>"
    # Required (≥16 chars) whenever a bootstrap admin username is set.
    JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN: "<enrollment token>"

  persistence:
    enabled: true
    size: "5Gi"
```

Install with:

```bash
helm install jivedrive deploy/helm/jivedrive \
  --namespace jivedrive --create-namespace --values prod-values.yaml
```

### Ephemeral: local cluster demo without a PVC

```yaml
jivedrive:
  persistence:
    enabled: false
  service:
    type: "LoadBalancer"
```

## Upgrading

The chart uses the `Recreate` strategy: an upgrade terminates the old pod
before starting the new one, so there is never more than one pod writing to
the SQLite database. The database file persists on the PVC across upgrades.
Migrations run automatically at startup. Always back up the PVC (or the
database file) before upgrading. This is the first release of the chart;
there are no prior releases to upgrade from.

## Uninstalling

```bash
helm uninstall jivedrive --namespace jivedrive
```

The PVC (and therefore the SQLite database) is kept by default after
uninstalling; delete it explicitly when the data is no longer needed:

```bash
kubectl delete pvc jivedrive-pvc --namespace jivedrive
```

Note that the PVC is bound to a specific volume; uninstalling and
reinstalling the chart reuses the same PVC only if its name matches
(`{{ .Release.Name }}-pvc`), so use the same release name to keep the data.
