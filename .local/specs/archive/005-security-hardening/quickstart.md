# Quickstart: Security Hardening

**Feature**: `005-security-hardening` | **Date**: 2026-08-18 | **Spec**: [spec.md](spec.md)

Key end-to-end scenarios that exercise the feature. Each can be run against
the backend test server (`backend/src/e2eServer.ts`) or the deployed stack.

## Scenario 1 — Username alone cannot enroll (C1/H1 closure)

```bash
# 1. Username-only register/options is refused with a generic error.
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"username":"john"}' https://drive.grimes.id.au/auth/register/options
# Expect: 400 {"error": ..., "code": ...} — no options, no existence hint.

# 2. A valid bootstrap enrollment token yields options for the admin.
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"token":"$JIVEDRIVE_BOOTSTRAP_ADMIN_ENROLLMENT_TOKEN"}' \
  https://drive.grimes.id.au/auth/register/options
# Expect: 200 with PublicKeyCredentialCreationOptions + username/bucket/prefix.
```

## Scenario 2 — Admin passkey reset yields a re-enrollment link and revokes sessions

```bash
# As the admin (session cookie):
curl -s -X DELETE -b 'jivedrive_session=...' \
  https://drive.grimes.id.au/api/admin/users/<id>/passkeys
# Expect: 200 {"invite": {...status: "pending"...}, "link": "https://drive.grimes.id.au/register?token=..."}

# The target's previous sessions are dead immediately (401 on any API call).
# The target opens the link and registers a fresh passkey (attach flow).
```

## Scenario 3 — Rate limiting bites

```bash
for i in $(seq 1 40); do
  curl -s -o /dev/null -w "%{http_code} " -X POST \
    -H 'Content-Type: application/json' -d '{}' \
    https://drive.grimes.id.au/auth/login/options
done
# Expect: a run of 200s then 429s with Retry-After on the /auth/* family.
```

## Scenario 4 — Security headers present

```bash
curl -sI https://drive.grimes.id.au/ | grep -iE 'content-security|x-frame|x-content|referrer|permissions|cache-control'
curl -sI https://drive.grimes.id.au/healthcheck | grep -i cache-control   # no-store
```

## Scenario 5 — Session idle expiry

Register a session (test server or e2e), advance the clock past
`JIVEDRIVE_SESSION_IDLE_DAYS` (tests inject `now`), call `/auth/me`:
expect `{"user": null}` and the row purged.

## Operational actions (from the security review — not tasks)

1. **Immediately**: sign in to `drive.grimes.id.au` as `john` and register the
   passkey (closes the currently open takeover window before this feature is
   built).
2. Verify the OVHcloud bucket is private (no public list/read) and its CORS
   policy allows only the app origin (`https://drive.grimes.id.au`).
3. Stand up a routine backup of the SQLite PVC (`/data/jivedrive.db`) — the
   chart keeps the PVC after `helm uninstall`; back up before upgrades.
