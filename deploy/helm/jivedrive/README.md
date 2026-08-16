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
- Automated CI: on push to `main`, the workflow in
  `.github/workflows/quality-and-deploy.yml` runs the quality gates, builds
  and publishes the image to GHCR, and deploys the chart to the minikube
  cluster with `values-ci.yaml` (image tag and S3 credentials passed as
  `--set` from GitHub secrets).

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

If you configured a bootstrap admin (see
[Examples](#examples)), open the site, enter the username, and complete the
passkey prompt. Otherwise, the first admin must be created from inside the
cluster (for example with a one-off `kubectl exec` against the database), or
by installing with the bootstrap admin environment variables set.

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
| `jivedrive.replicas` | Number of replicas; keep at `1` (SQLite, single-writer) | `1` |
| `jivedrive.resources.requests.memory` | Memory request for the server container | unset |
| `jivedrive.resources.requests.cpu` | CPU request for the server container | unset |
| `jivedrive.resources.limits.memory` | Memory limit for the server container | unset |
| `jivedrive.resources.limits.cpu` | CPU limit for the server container | unset |
| `jivedrive.nodeSelector` | Node selector for pod scheduling | `{}` |
| `jivedrive.tolerations` | Tolerations for pod scheduling | `[]` |
| `jivedrive.affinity` | Affinity rules for pod scheduling | `{}` |
| `jivedrive.config` | Map of non-sensitive `JIVEDRIVE_*` environment variables | see below |
| `jivedrive.secretConfig` | Map of sensitive `JIVEDRIVE_*` environment variables (S3 credentials) | empty keys |
| `jivedrive.service.type` | Kubernetes Service type | `ClusterIP` |
| `jivedrive.service.port` | Service port | `80` |
| `jivedrive.persistence.enabled` | Mount a PVC for the SQLite database | `false` |
| `jivedrive.persistence.size` | PVC size when enabled | `1Gi` |
| `jivedrive.persistence.mountPath` | Mount path for the database volume | `/data` |
| `jivedrive.persistence.storageClassName` | Storage class for the PVC | unset (cluster default) |

### Environment variables

The following `JIVEDRIVE_*` variables are read by the backend
(`backend/src/config.ts`). Non-secret variables belong in `jivedrive.config`;
secrets belong in `jivedrive.secretConfig`. Defaults below match the backend's
defaults, except where the chart defaults to the production deployment
(`drive.grimes.id.au`, OVHcloud GRA).

| Variable | Description | Chart default |
| -------- | ----------- | ------------- |
| `JIVEDRIVE_PORT` | HTTP port the server listens on; must match the container port `3000` in the deployment template | `3000` |
| `JIVEDRIVE_DB_PATH` | SQLite database file path; keep it under `jivedrive.persistence.mountPath` | `/data/jivedrive.db` |
| `JIVEDRIVE_MIGRATIONS_DIR` | Directory of SQL migration files (baked into the image) | `/app/migrations` |
| `JIVEDRIVE_SESSION_TTL_DAYS` | Session lifetime in days | `30` |
| `JIVEDRIVE_S3_ENDPOINT` | OVHcloud Object Storage S3 endpoint URL | `https://s3.gra.io.cloud.ovh.net` |
| `JIVEDRIVE_S3_REGION` | OVHcloud region | `gra` |
| `JIVEDRIVE_S3_ACCESS_KEY_ID` | S3 access key id (secret; required) | `""` |
| `JIVEDRIVE_S3_SECRET_ACCESS_KEY` | S3 secret access key (secret; required) | `""` |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME` | Bootstrap admin username, provisioned at first start (optional) | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET` | Bucket for the bootstrap admin (required when a username is set) | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX` | Prefix for the bootstrap admin | unset |
| `JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN` | Whether the bootstrap account is an admin (`true`/`false`) | `true` |
| `JIVEDRIVE_WEBAUTHN_RP_ID` | WebAuthn relying party id; must match the site's registrable domain | `drive.grimes.id.au` |
| `JIVEDRIVE_WEBAUTHN_ORIGIN` | WebAuthn relying party origin; must be the https origin users sign in from | `https://drive.grimes.id.au` |

The app refuses to start when `JIVEDRIVE_S3_ACCESS_KEY_ID` or
`JIVEDRIVE_S3_SECRET_ACCESS_KEY` is missing, and in production
(`NODE_ENV=production`, set by the image) when the WebAuthn variables are
missing or not https.

## Examples

### Production: persistent storage, bootstrap admin, custom image

```yaml
jivedrive:
  image:
    repository: "registry.example.com/jivedrive"
    tag: "1.2.3"
    pullPolicy: "IfNotPresent"

  config:
    JIVEDRIVE_S3_ENDPOINT: "https://s3.gra.io.cloud.ovh.net"
    JIVEDRIVE_S3_REGION: "gra"
    JIVEDRIVE_WEBAUTHN_RP_ID: "drive.grimes.id.au"
    JIVEDRIVE_WEBAUTHN_ORIGIN: "https://drive.grimes.id.au"
    JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME: "admin"
    JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET: "jivedrive-prod"
    JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX: "users/admin/"
    JIVEDRIVE_BOOTSTRAP_ADMIN_IS_ADMIN: "true"

  secretConfig:
    JIVEDRIVE_S3_ACCESS_KEY_ID: "<access key>"
    JIVEDRIVE_S3_SECRET_ACCESS_KEY: "<secret key>"

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
