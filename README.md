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
- Uncluttered rows: each listing and search row keeps its actions (file
  Download/Share/Move/Delete, own-folder Share) behind a single "⋯" menu,
  and clicking a file's name in the listing downloads it.
- Sync with rclone (optional): from Settings, every user can issue
  labelled S3 keys scoped to their own bucket and prefix and copy a ready
  `rclone.conf`, to sync their drive to a computer with `rclone sync` or
  `rclone bisync`. See [Sync with rclone](#sync-with-rclone).
- MCP server for AI assistants: Claude (claude.ai, Claude Desktop) and
  other MCP clients can connect to `<origin>/mcp` as a custom connector,
  signing in with a passkey and approving access via OAuth. The assistant
  can list, search and read files, create folders, write files of any type, move
  files and create short share links - never delete files. See
  [MCP server](#mcp-server-ai-assistants).

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
server on `http://localhost:5173`. The Vite server proxies `/api`, `/auth`,
`/healthcheck`, `/s`, `/mcp`, `/oauth` and `/.well-known` to the backend (see
`frontend/vite.config.ts`), so browse to
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
| `JIVEDRIVE_OVH_ENDPOINT`                 | unset                   | for rclone sync   | OVHcloud API: `ovh-eu`, `ovh-ca`, `ovh-us` or an http(s) base URL               |
| `JIVEDRIVE_OVH_PROJECT_ID`               | unset                   | for rclone sync   | Public Cloud project owning the Object Storage users                            |
| `JIVEDRIVE_OVH_APPLICATION_KEY`          | unset                   | for rclone sync   | OVHcloud API application key (secret)                                           |
| `JIVEDRIVE_OVH_APPLICATION_SECRET`       | unset                   | for rclone sync   | OVHcloud API application secret (secret)                                        |
| `JIVEDRIVE_OVH_CONSUMER_KEY`             | unset                   | for rclone sync   | OVHcloud API consumer key (secret)                                              |

The `JIVEDRIVE_OVH_*` variables are optional and all-or-nothing (empty
counts as unset): with all five unset rclone sync is disabled; if any is
set, all five must be, or startup fails listing the missing ones.

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

## Sync with rclone

When the `JIVEDRIVE_OVH_*` variables are set, the Settings page (the gear
in the header, shown to every signed-in user) has a "Sync with rclone"
section. A user creates a labelled key (up to 10, read-write, never
expiring) and is shown, once, a copyable `rclone.conf` block, the example
commands `rclone sync jivedrive: ~/JiveDrive` and, for two-way sync (the
local folder must exist first, or bisync fails with "directory not
found"):

```sh
mkdir -p ~/JiveDrive
rclone bisync jivedrive: ~/JiveDrive --resync  # first run only
```

plus the raw values. JiveDrive never stores the secret; each key can be
revoked on its own. A new key can take up to about a minute to start
working. When the feature is not configured the page says so.

How it works: for every key the server creates a dedicated OVHcloud Object
Storage user (role `objectstore_operator`, description
`jivedrive:<username>`) through the OVHcloud API, attaches a policy that
allows listing, reading, writing and deleting only under the user's own
prefix (and denies listing buckets), then mints the S3 key for it. There
is one OVHcloud user per key, so admins will see several
`jivedrive:<username>` users in the OVHcloud console for a user with
several keys. Revoking a key replaces its user's policy with deny-all,
then deletes the key and the OVHcloud user; the key stops working within
a few minutes (OVHcloud caches credentials, so deleting a key alone does
not stop it promptly). When an admin removes a JiveDrive user, all of
their keys are revoked this way first; if that fails, the JiveDrive user
is kept so the admin can retry. A user whose prefix contains `*` or `?`
cannot be given sync keys.

Limitations: folders shared with the user are not included; changes made
through rclone appear in search after the next background scan; moving or
deleting files through rclone breaks existing share links to them.

### Creating the OVHcloud API token

1. Create an application at `https://ca.api.ovh.com/createApp/` (or the
   `eu`/`us` equivalent matching `JIVEDRIVE_OVH_ENDPOINT`) to get the
   application key and secret.
2. Request a consumer key restricted to the project's Object Storage users,
   with unlimited validity, via the API:

   ```sh
   curl -X POST https://ca.api.ovh.com/1.0/auth/credential \
     -H "X-Ovh-Application: <application key>" \
     -H "Content-Type: application/json" \
     -d '{"accessRules": [
       {"method": "GET", "path": "/cloud/project/<project id>/user"},
       {"method": "POST", "path": "/cloud/project/<project id>/user"},
       {"method": "DELETE", "path": "/cloud/project/<project id>/user"},
       {"method": "GET", "path": "/cloud/project/<project id>/user/*"},
       {"method": "POST", "path": "/cloud/project/<project id>/user/*"},
       {"method": "DELETE", "path": "/cloud/project/<project id>/user/*"}
     ]}'
   ```

   The response holds the `consumerKey` and a `validationUrl`: open the
   URL, sign in to the OVHcloud account, and choose an unlimited validity.
   Avoid the `createToken` web form: it mangled the `*` in the access-rule
   paths when this was set up.

3. Set `JIVEDRIVE_OVH_APPLICATION_KEY`, `JIVEDRIVE_OVH_APPLICATION_SECRET`
   and `JIVEDRIVE_OVH_CONSUMER_KEY` (secrets), plus `JIVEDRIVE_OVH_ENDPOINT`
   and `JIVEDRIVE_OVH_PROJECT_ID`.

## MCP server (AI assistants)

JiveDrive is a remote [Model Context Protocol](https://modelcontextprotocol.io)
server at `<origin>/mcp` (`https://drive.grimes.id.au/mcp` in production),
so an AI assistant can work with a user's drive on their behalf.

### Connecting Claude

In Claude (claude.ai or Claude Desktop), open Settings → Connectors → Add
custom connector, and enter `https://drive.grimes.id.au/mcp` as the URL
(leave the OAuth client fields empty). Claude opens a JiveDrive consent
page: sign in with your passkey if prompted, check the app name and the
list of what it can do, and choose **Allow**. Any MCP client that supports
the MCP authorization spec (OAuth 2.1 with dynamic client registration and
PKCE) connects the same way.

Every connection is listed under **Connected apps** in Settings with when
it was connected and last used; **Revoke** cuts it off immediately. A
connection unused for 30 days expires (its refresh token lapses) and drops
off the list; the app must then be connected again. Removing a user
removes their connections.

### Tools

| Tool                | What it does                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_spaces`       | Lists the user's own drive (`own`) and each folder shared with them (`shared:<id>`)                                                                                                                                                                   |
| `list_folder`       | Lists a folder's subfolders and files, 1000 entries per page                                                                                                                                                                                          |
| `search`            | The same search as the Files page (names and content, own drive and shared folders, 50 results)                                                                                                                                                       |
| `read_file`         | Text files as text, PDF/DOCX as extracted text, images as images; text is paged 100,000 characters at a time                                                                                                                                          |
| `create_folder`     | Creates a folder inside an existing folder                                                                                                                                                                                                            |
| `write_file`        | Writes a file (up to 10 MiB) into an existing folder: text as-is or any binary type as base64 (`encoding: "base64"`), with the Content-Type guessed from the extension unless `contentType` is given; replaces an existing file only with `overwrite` |
| `move_file`         | Moves a file to another existing folder of the same space, refusing name clashes (share links and search follow it)                                                                                                                                   |
| `create_share_link` | Creates a short share link to an existing file (`1h`, `24h`, `7d` or `30d`, default `7d`); the same file and lifetime return the same link                                                                                                            |

Every tool is limited to the user's own bucket and prefix and the folders
shared with them, exactly like the web app. There is no tool to delete
files. Share links created by the assistant are the same anonymous
`<origin>/s/<token>` links as the web app's Share action: owned by the
user, working for anyone until they expire, and never revocable early.
`read_file` refuses files larger than `JIVEDRIVE_SEARCH_INDEX_MAX_BYTES`
and binary formats other than images. Files written by the assistant
appear in search after the next background index scan, like uploads.

### How it works

The endpoint speaks the stateless Streamable HTTP transport: JSON-RPC 2.0
over `POST /mcp` with JSON responses (no SSE streams or sessions).
JiveDrive is its own minimal OAuth 2.1 authorization server, all derived
from `JIVEDRIVE_WEBAUTHN_ORIGIN` with no extra configuration:

- Discovery: `/.well-known/oauth-protected-resource` (RFC 9728) and
  `/.well-known/oauth-authorization-server` (RFC 8414); an unauthenticated
  `/mcp` call returns `401` with a `WWW-Authenticate` header pointing at
  the resource metadata.
- `/oauth/register`: dynamic client registration (RFC 7591) for public
  clients with `https` or loopback `http` redirect URIs.
- `/oauth/authorize` → the `/authorize` consent page → `/oauth/token`:
  authorization code grant with PKCE (S256 only) and the `resource`
  parameter (RFC 8707).
- Access tokens last 1 hour; refresh tokens last 30 days and rotate on
  every use, and presenting a used refresh token revokes the connection.
  Tokens are stored only as SHA-256 hashes. `/oauth/revoke` (RFC 7009)
  revokes a connection from the client side.

Behind your own Ingress, route `/mcp`, `/oauth/*` and `/.well-known/*` to
the Service along with everything else.

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
frontend/    React + Vite SPA (static assets, icons and manifest in public/)
e2e/         Playwright end-to-end tests
docker/      Multi-stage Dockerfile
deploy/      Helm chart
docs/        Validation and operations documentation
scripts/     curl-based verification scripts and the icon generator
```

The favicon and app icons are generated from `frontend/public/favicon.svg`:
after changing the SVG, run `bun run icons` to re-render the PNG and ICO
files with Playwright's Chromium, and commit the results.

Copyright © 2026, John Grimes.
