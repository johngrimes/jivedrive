#!/usr/bin/env bash
# Verify the admin user-management flow (User Story 6) against a running
# server with a mocked S3 layer. Boots the e2e server on port 5175 with a
# file-backed SQLite database and in-memory mock object store, then
# exercises the /api/admin endpoints with curl: create/resend/cancel/list
# invites, register an invitee through the real WebAuthn flow (crafted
# with the test keypair helpers), passkey reset (200 {invite, link},
# session revocation, re-enrollment via the returned link), list/remove
# users, the last-admin and remove-self protections, non-admin 403s, and
# storage untouched by user removal.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="http://localhost:5175"
ADMIN_COOKIE="jivedrive_session=admin-session"
ALICE_COOKIE="jivedrive_session=browse-session"
DB_FILE="$(mktemp -u /tmp/jivedrive-admin-verify.XXXXXX.db)"
FAILED=0

# Refuse to clobber a server that is already listening on 5175.
if curl -sf "$BASE_URL/healthcheck" >/dev/null 2>&1; then
  echo "A server is already running on $BASE_URL; stop it first." >&2
  exit 1
fi

# Start the e2e server (seeded DB + mock S3) on 5175 with a file-backed
# database so persistence can be inspected from outside the process.
JIVEDRIVE_PORT=5175 JIVEDRIVE_DB_PATH="$DB_FILE" bun run backend/src/e2eServer.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true; rm -f "$DB_FILE"' EXIT

# Wait for the API to come up.
for _ in $(seq 1 50); do
  if curl -sf "$BASE_URL/healthcheck" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -sf "$BASE_URL/healthcheck" >/dev/null || {
  echo "e2e server did not start" >&2
  exit 1
}

# Generic check: run curl with the given method/path/cookie/body and
# compare the HTTP status.
check() {
  local label="$1" expected="$2" method="$3" path="$4" cookie="${5:-}" body="${6:-}"
  local tmp code
  tmp=$(mktemp)
  local args=(-s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path")
  if [[ -n "$cookie" ]]; then args+=(-b "$cookie"); fi
  if [[ -n "$body" ]]; then args+=(-H "Content-Type: application/json" -d "$body"); fi
  code=$(curl "${args[@]}")
  if [[ "$code" == "$expected" ]]; then
    printf 'PASS %-52s HTTP %s\n' "$label" "$code"
  else
    printf 'FAIL %-52s expected HTTP %s, got %s\n' "$label" "$expected" "$code"
    FAILED=1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

# Register a real user against an invite token through the API: fetch
# registration options, craft a valid WebAuthn response with the test
# keypair helpers, and verify. Prints the set-cookie session header (or
# nothing) so the caller can later prove the session is invalidated.
register_via_api() {
  local token="$1" cred_hex="$2"
  TOKEN="$token" CRED_ID="$cred_hex" BASE_URL="$BASE_URL" bun -e '
    import {
      makeKeyPair,
      makeRegistrationResponse,
    } from "./backend/tests/webauthn-test-helpers";
    const base = process.env.BASE_URL;
    const token = process.env.TOKEN;
    const credentialId = Buffer.from(process.env.CRED_ID, "hex");
    const optsRes = await fetch(`${base}/auth/register/options`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!optsRes.ok) {
      console.error(`register/options failed: ${optsRes.status}`);
      process.exit(1);
    }
    const opts = await optsRes.json();
    const keyPair = makeKeyPair();
    const credential = makeRegistrationResponse({
      challenge: opts.options.challenge,
      origin: "http://localhost:5173",
      rpId: "localhost",
      keyPair,
      credentialId,
    });
    const verifyRes = await fetch(`${base}/auth/register/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, credential }),
    });
    const body = await verifyRes.json();
    if (!verifyRes.ok) {
      console.error(
        `register/verify failed: ${verifyRes.status} ${JSON.stringify(body)}`,
      );
      process.exit(1);
    }
    console.error(`registered ${body.user.username}`);
    console.log(verifyRes.headers.get("set-cookie") ?? "");
  '
}

# JSON field extractor for the last check output file.
field() {
  jq -r "$2" <<<"$1"
}

# --- 1. Invite lifecycle -------------------------------------------------
echo "== Invite lifecycle =="
RESP=$(mktemp)
CREATE=$(curl -s -o "$RESP" -w "%{http_code}" -X POST \
  -b "$ADMIN_COOKIE" -H "Content-Type: application/json" \
  -d '{"username":"zoe","bucket":"jivedrive-prod","prefix":"users/zoe/"}' \
  "$BASE_URL/api/admin/invites")
if [[ "$CREATE" == "201" ]]; then
  ZOE_LINK=$(jq -r .link "$RESP")
  ZOE_ID=$(jq -r .invite.id "$RESP")
  echo "PASS create invite -> HTTP 201, link: $ZOE_LINK"
  if [[ "$ZOE_LINK" != http://localhost:5173/register?token=* ]]; then
    echo "FAIL created link does not carry the token: $ZOE_LINK"
    FAILED=1
  fi
  if [[ "$(jq -r .invite.status "$RESP")" != "pending" ]]; then
    echo "FAIL new invite is not pending: $(cat "$RESP")"
    FAILED=1
  fi
else
  echo "FAIL create invite expected HTTP 201, got $CREATE: $(cat "$RESP")"
  FAILED=1
fi

# The invite is listed as pending.
INVITES=$(curl -s "$BASE_URL/api/admin/invites" -b "$ADMIN_COOKIE")
if jq -e ".invites[] | select(.username == \"zoe\" and .status == \"pending\")" >/dev/null <<<"$INVITES"; then
  echo "PASS listed invites include zoe as pending"
else
  echo "FAIL zoe not pending in the invite list: $INVITES"
  FAILED=1
fi

# Re-send: fresh token and a fresh 48-hour expiry.
RESEND=$(curl -s -o "$RESP" -w "%{http_code}" -X POST \
  -b "$ADMIN_COOKIE" "$BASE_URL/api/admin/invites/$ZOE_ID/resend")
if [[ "$RESEND" == "200" ]]; then
  NEW_LINK=$(jq -r .link "$RESP")
  NEW_EXPIRY=$(jq -r .invite.expiresAt "$RESP")
  NOW_MS=$(date +%s000)
  EXPIRY_MS=$(date -d "$NEW_EXPIRY" +%s000 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${NEW_EXPIRY%Z}" +%s000 2>/dev/null || echo 0)
  echo "PASS resend invite -> HTTP 200, new link: $NEW_LINK"
  if [[ "$NEW_LINK" == "$ZOE_LINK" ]]; then
    echo "FAIL resend returned the same link (token not refreshed)"
    FAILED=1
  fi
  # ~48 hours (within a 2-minute clock tolerance).
  if (( EXPIRY_MS - NOW_MS < 47 * 3600 * 1000 || EXPIRY_MS - NOW_MS > 48 * 3600 * 1000 + 120000 )); then
    echo "FAIL resend expiry is not ~48h away: expiresAt=$NEW_EXPIRY"
    FAILED=1
  else
    echo "PASS resend expiry is 48 hours out (expiresAt=$NEW_EXPIRY)"
  fi
else
  echo "FAIL resend invite expected HTTP 200, got $RESEND: $(cat "$RESP")"
  FAILED=1
fi

# Cancel: 204 and gone from the list.
check "cancel invite" 204 "DELETE" "/api/admin/invites/$ZOE_ID" "$ADMIN_COOKIE"
INVITES=$(curl -s "$BASE_URL/api/admin/invites" -b "$ADMIN_COOKIE")
if jq -e ".invites[] | select(.username == \"zoe\")" >/dev/null <<<"$INVITES"; then
  echo "FAIL cancelled invite still listed: $INVITES"
  FAILED=1
else
  echo "PASS cancelled invite is gone from the list"
fi
rm -f "$RESP"

# --- 2. Invite -> register -> claimed ------------------------------------
echo "== Register flow =="
RESP=$(mktemp)
curl -s -o "$RESP" -w "" -X POST -b "$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"username":"yuri","bucket":"jivedrive-prod","prefix":"users/yuri/"}' \
  "$BASE_URL/api/admin/invites"
YURI_TOKEN=$(jq -r .link "$RESP" | sed 's/.*token=//')
echo "created invite for yuri (token: ${YURI_TOKEN:0:12}...)"

YURI_SESSION=$(register_via_api "$YURI_TOKEN" "42")
if [[ -z "$YURI_SESSION" ]]; then
  echo "FAIL yuri registration did not set a session cookie"
  FAILED=1
else
  echo "PASS yuri registered via the API and received a session"
fi

# The invite is now claimed in the admin list.
INVITES=$(curl -s "$BASE_URL/api/admin/invites" -b "$ADMIN_COOKIE")
if jq -e ".invites[] | select(.username == \"yuri\" and .status == \"claimed\")" >/dev/null <<<"$INVITES"; then
  echo "PASS yuri's invite shows as claimed"
else
  echo "FAIL yuri's invite not claimed: $INVITES"
  FAILED=1
fi

# yuri appears in the user list.
USERS=$(curl -s "$BASE_URL/api/admin/users" -b "$ADMIN_COOKIE")
YURI_ID=$(jq -r '.users[] | select(.username == "yuri") | .id' <<<"$USERS")
if [[ -n "$YURI_ID" ]]; then
  echo "PASS yuri appears in the user list"
else
  echo "FAIL yuri missing from the user list: $USERS"
  FAILED=1
fi

# --- 2b. Passkey reset: 200 {invite, link}, revocation, re-enrollment ----
# The reset endpoint changed from 204 to 200 {invite, link} (spec 005
# US2/FR-006): it deletes the user's credentials, revokes ALL of the
# user's sessions, cancels pending invites for the username, and returns a
# fresh 48-hour re-enrollment invite link. Re-enrolling through that link
# goes through the US1 attach flow: the invite's username matches the
# existing zero-passkey account with identical bucket/prefix/isAdmin, so
# the passkey attaches to the same user row.
echo "== Passkey reset =="
RESP=$(mktemp)

# Create an invite for a fresh username and enroll them via the token flow
# (no username-based enrollment exists any more - register/options and
# register/verify accept a token only, FR-001/FR-002).
curl -s -o "$RESP" -w "" -X POST -b "$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"username":"walter","bucket":"jivedrive-prod","prefix":"users/walter/"}' \
  "$BASE_URL/api/admin/invites"
WALTER_TOKEN=$(jq -r .link "$RESP" | sed 's/.*token=//')
WALTER_SESSION=$(register_via_api "$WALTER_TOKEN" "44")
if [[ -z "$WALTER_SESSION" ]]; then
  echo "FAIL walter registration did not set a session cookie"
  FAILED=1
else
  echo "PASS walter enrolled via the invite token and received a session"
fi
WALTER_ID=$(curl -s "$BASE_URL/api/admin/users" -b "$ADMIN_COOKIE" | \
  jq -r '.users[] | select(.username == "walter") | .id')
if [[ -z "$WALTER_ID" ]]; then
  echo "FAIL walter missing from the user list"
  FAILED=1
fi

# Admin reset: HTTP 200 with {invite, link}.
RESET=$(curl -s -o "$RESP" -w "%{http_code}" -X DELETE \
  -b "$ADMIN_COOKIE" "$BASE_URL/api/admin/users/$WALTER_ID/passkeys")
if [[ "$RESET" == "200" ]]; then
  echo "PASS reset passkeys -> HTTP 200"
else
  echo "FAIL reset passkeys expected HTTP 200, got $RESET: $(cat "$RESP")"
  FAILED=1
fi
RESET_BODY=$(cat "$RESP")

# The returned invite is pending and carries the user's bucket/prefix.
if [[ "$(jq -r .invite.status <<<"$RESET_BODY")" == "pending" ]] \
  && [[ "$(jq -r .invite.username <<<"$RESET_BODY")" == "walter" ]] \
  && [[ "$(jq -r .invite.bucket <<<"$RESET_BODY")" == "jivedrive-prod" ]] \
  && [[ "$(jq -r .invite.prefix <<<"$RESET_BODY")" == "users/walter/" ]]; then
  echo "PASS reset invite is pending with walter's bucket/prefix"
else
  echo "FAIL reset invite shape: $RESET_BODY"
  FAILED=1
fi
WALTER_LINK=$(jq -r .link <<<"$RESET_BODY")
if [[ "$WALTER_LINK" == http://localhost:5173/register?token=* ]]; then
  echo "PASS reset link carries the registration token"
else
  echo "FAIL reset link malformed: $WALTER_LINK"
  FAILED=1
fi

# The user's old session no longer resolves after the reset (FR-006).
ME=$(curl -s "$BASE_URL/auth/me" -b "$WALTER_SESSION")
if jq -e ".user == null" >/dev/null <<<"$ME"; then
  echo "PASS walter's old session is revoked (/auth/me reports null)"
else
  echo "FAIL walter's old session still resolves: $ME"
  FAILED=1
fi

# A fresh pending invite for the username is in the admin list.
INVITES=$(curl -s "$BASE_URL/api/admin/invites" -b "$ADMIN_COOKIE")
if jq -e ".invites[] | select(.username == \"walter\" and .status == \"pending\")" >/dev/null <<<"$INVITES"; then
  echo "PASS reset invite listed as pending for walter"
else
  echo "FAIL walter's reset invite not pending in the list: $INVITES"
  FAILED=1
fi

# Re-enroll via the returned link (US1 attach flow: same username,
# matching scope, zero discoverable passkeys -> succeeds).
WALTER_RE_TOKEN=$(jq -r .link <<<"$RESET_BODY" | sed 's/.*token=//')
WALTER_RE_SESSION=$(register_via_api "$WALTER_RE_TOKEN" "45")
if [[ -z "$WALTER_RE_SESSION" ]]; then
  echo "FAIL walter re-enrollment via the reset link did not set a session"
  FAILED=1
else
  echo "PASS walter re-enrolled via the reset link (attach flow)"
fi

# Attach never duplicates: exactly one walter user row exists.
USERS=$(curl -s "$BASE_URL/api/admin/users" -b "$ADMIN_COOKIE")
if [[ "$(jq '[.users[] | select(.username == "walter")] | length' <<<"$USERS")" == "1" ]]; then
  echo "PASS re-enrollment attached to the existing account (no duplicate user)"
else
  echo "FAIL re-enrollment created a duplicate user: $USERS"
  FAILED=1
fi

# The re-enrollment session resolves to the same account.
ME=$(curl -s "$BASE_URL/auth/me" -b "$WALTER_RE_SESSION")
if jq -e ".user != null and .user.username == \"walter\"" >/dev/null <<<"$ME"; then
  echo "PASS walter's new session resolves after re-enrollment"
else
  echo "FAIL walter's new session does not resolve: $ME"
  FAILED=1
fi
rm -f "$RESP"

# --- 3. Removal ----------------------------------------------------------
echo "== User removal =="
ALICE_BEFORE=$(curl -s "$BASE_URL/api/files" -b "$ALICE_COOKIE")
check "remove non-admin user yuri" 204 "DELETE" \
  "/api/admin/users?id=$YURI_ID" "$ADMIN_COOKIE"

# yuri is gone from the user list and their session no longer resolves.
USERS=$(curl -s "$BASE_URL/api/admin/users" -b "$ADMIN_COOKIE")
if jq -e ".users[] | select(.username == \"yuri\")" >/dev/null <<<"$USERS"; then
  echo "FAIL removed user still listed: $USERS"
  FAILED=1
else
  echo "PASS removed user is gone from the user list"
fi
ME=$(curl -s "$BASE_URL/auth/me" -b "$YURI_SESSION")
if jq -e ".user == null" >/dev/null <<<"$ME"; then
  echo "PASS removed user's session is invalid (/auth/me reports null)"
else
  echo "FAIL removed user's session still resolves: $ME"
  FAILED=1
fi

# Storage untouched: alice's listing is byte-identical after all the admin
# operations (removal of a user never touches storage objects, FR-014).
ALICE_AFTER=$(curl -s "$BASE_URL/api/files" -b "$ALICE_COOKIE")
if [[ "$ALICE_BEFORE" == "$ALICE_AFTER" ]]; then
  echo "PASS storage untouched: alice's listing is unchanged after user removal"
else
  echo "FAIL storage changed during admin flow"
  FAILED=1
fi

# Cannot remove yourself; cannot remove the last admin.
ADMIN_ID=$(jq -r '.users[] | select(.username == "admin") | .id' <<<"$USERS")
check "cannot remove yourself (single admin)" 400 "DELETE" \
  "/api/admin/users?id=$ADMIN_ID" "$ADMIN_COOKIE"
BODY=$(curl -s -X DELETE -b "$ADMIN_COOKIE" "$BASE_URL/api/admin/users?id=$ADMIN_ID")
if jq -e ".code == \"last_admin\"" >/dev/null <<<"$BODY"; then
  echo "PASS the single admin is protected as the last admin"
else
  echo "FAIL expected last_admin code, got: $BODY"
  FAILED=1
fi

# With a second admin present, removing yourself is refused as remove_self
# and removing the other admin is allowed.
RESP2=$(mktemp)
curl -s -o "$RESP2" -w "" -X POST -b "$ADMIN_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"username":"xander","bucket":"jivedrive-prod","prefix":"users/xander/","isAdmin":true}' \
  "$BASE_URL/api/admin/invites"
XANDER_TOKEN=$(jq -r .link "$RESP2" | sed 's/.*token=//')
register_via_api "$XANDER_TOKEN" "43" >/dev/null
XANDER_ID=$(curl -s "$BASE_URL/api/admin/users" -b "$ADMIN_COOKIE" | \
  jq -r '.users[] | select(.username == "xander") | .id')
BODY=$(curl -s -X DELETE -b "$ADMIN_COOKIE" "$BASE_URL/api/admin/users?id=$ADMIN_ID")
if jq -e ".code == \"remove_self\"" >/dev/null <<<"$BODY"; then
  echo "PASS cannot remove yourself (remove_self) when another admin exists"
else
  echo "FAIL expected remove_self code, got: $BODY"
  FAILED=1
fi
check "remove the other admin" 204 "DELETE" \
  "/api/admin/users?id=$XANDER_ID" "$ADMIN_COOKIE"
rm -f "$RESP" "$RESP2"

# --- 4. Non-admin access is refused --------------------------------------
echo "== Non-admin access (FR-015) =="
check "non-admin GET users" 403 "GET" "/api/admin/users" "$ALICE_COOKIE"
check "non-admin GET invites" 403 "GET" "/api/admin/invites" "$ALICE_COOKIE"
check "non-admin POST invites" 403 "POST" "/api/admin/invites" "$ALICE_COOKIE" \
  '{"username":"nope","bucket":"b","prefix":"n/"}' 
check "non-admin DELETE users" 403 "DELETE" "/api/admin/users?id=x" "$ALICE_COOKIE"
check "non-admin DELETE invites" 403 "DELETE" "/api/admin/invites/x" "$ALICE_COOKIE"
check "non-admin resend" 403 "POST" "/api/admin/invites/x/resend" "$ALICE_COOKIE"
check "unsigned GET users" 401 "GET" "/api/admin/users"

exit "$FAILED"
