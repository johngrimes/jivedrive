#!/usr/bin/env bash
# Verify the folder sharing flow (spec 006, User Stories 1-4) against a
# running server with a mocked S3 layer. Boots the e2e server on port
# 5174 with a file-backed SQLite database and in-memory mock object
# store, then exercises the share API with curl as the seeded users:
# user search (GET /api/users), share creation and its refusals
# (POST /api/shares), listing (GET /api/shares), revocation
# (DELETE /api/shares/:id) and the post-revocation 404 on the shared
# space as bob.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="http://localhost:5174"
ALICE_SESSION="jivedrive_session=browse-session"
BOB_SESSION="jivedrive_session=bob-session"
DB_FILE="$(mktemp -u /tmp/jivedrive-folder-share-verify.XXXXXX.db)"
FAILED=0

# Refuse to clobber a server that is already listening on 5174.
if curl -sf "$BASE_URL/healthcheck" >/dev/null 2>&1; then
  echo "A server is already running on $BASE_URL; stop it first." >&2
  exit 1
fi

# Start the e2e server (seeded DB + mock S3) on 5174 with a file-backed
# database so persistence can be inspected from outside the process.
JIVEDRIVE_PORT=5174 JIVEDRIVE_DB_PATH="$DB_FILE" bun run backend/src/e2eServer.ts &
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

check() {
  local label="$1" expected="$2" method="$3" path="$4" data="$5" auth="${6:-}"
  local tmp code body
  tmp=$(mktemp)
  local args=(-s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path"
    -H "Content-Type: application/json")
  if [[ "$auth" == "alice" ]]; then args+=(-b "$ALICE_SESSION"); fi
  if [[ "$auth" == "bob" ]]; then args+=(-b "$BOB_SESSION"); fi
  if [[ -n "$data" ]]; then args+=(-d "$data"); fi
  code=$(curl "${args[@]}")
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [[ "$code" == "$expected" ]]; then
    printf 'PASS %-54s HTTP %s %s\n' "$label" "$code" "$body"
  else
    printf 'FAIL %-54s expected HTTP %s, got %s %s\n' "$label" "$expected" "$code" "$body"
    FAILED=1
  fi
}

# User search (FR-006): "bo" finds bob as an identity-only summary; the
# payload never leaks bucket, prefix or admin status.
SEARCH=$(curl -s "$BASE_URL/api/users?q=bo" -b "$ALICE_SESSION")
if grep -q '"username":"bob"' <<<"$SEARCH"; then
  echo "PASS search q=bo returns bob"
else
  echo "FAIL search q=bo did not return bob: $SEARCH"
  FAILED=1
fi
if grep -Eq '"(bucket|prefix|isAdmin)"' <<<"$SEARCH"; then
  echo "FAIL search result leaked storage/admin fields: $SEARCH"
  FAILED=1
else
  echo "PASS search result is identity-only (no bucket/prefix/isAdmin)"
fi
check "unsigned search refused" 401 GET "/api/users?q=bo" ""

# Share creation: 201, duplicate 409, self-share 400, plus the other
# contract refusals (unknown recipient, root folder, unsigned).
check "alice shares projects with bob" 201 POST /api/shares \
  '{"folder":"projects/","recipientUsername":"bob"}' alice
check "duplicate share refused" 409 POST /api/shares \
  '{"folder":"projects/","recipientUsername":"bob"}' alice
check "self-share refused" 400 POST /api/shares \
  '{"folder":"projects/","recipientUsername":"alice"}' alice
check "unknown recipient refused" 404 POST /api/shares \
  '{"folder":"projects/","recipientUsername":"nobody"}' alice
check "root folder not shareable" 400 POST /api/shares \
  '{"folder":"","recipientUsername":"bob"}' alice
check "unsigned create refused" 401 POST /api/shares \
  '{"folder":"projects/","recipientUsername":"bob"}'

# Listing (R5): alice's outgoing shares carry the contract shape with
# the normalised folder and the recipient's identity.
LIST=$(curl -s "$BASE_URL/api/shares" -b "$ALICE_SESSION")
if grep -q '"folder":"projects/"' <<<"$LIST" && grep -q '"username":"bob"' <<<"$LIST"; then
  echo "PASS list shows the outgoing share (folder projects/, recipient bob)"
else
  echo "FAIL outgoing share missing from list: $LIST"
  FAILED=1
fi
SHARE_ID=$(sed -n 's/.*"outgoing":\[{"id":"\([^"]*\)".*/\1/p' <<<"$LIST")
if [[ -z "$SHARE_ID" ]]; then
  echo "FAIL could not extract the outgoing share id"
  FAILED=1
else
  echo "PASS outgoing share id: $SHARE_ID"
fi

# As bob the shared space resolves and lists the sharer's folder before
# the revocation (US2); the mount-relative listing returns plan.txt.
if [[ -n "$SHARE_ID" ]]; then
  BOB_LIST=$(curl -s "$BASE_URL/api/files?space=shared:${SHARE_ID}" \
    -b "$BOB_SESSION")
  if grep -q 'plan.txt' <<<"$BOB_LIST"; then
    echo "PASS bob lists the shared folder (plan.txt visible) before revocation"
  else
    echo "FAIL bob could not list the shared space: $BOB_LIST"
    FAILED=1
  fi
fi

# Revocation (US4): the owner deletes the row (204); bob's next request
# against the space 404s and the owner's listing drops the share.
check "alice revokes the share" 204 DELETE "/api/shares/$SHARE_ID" "" alice
if [[ -n "$SHARE_ID" ]]; then
  REVOKED=$(curl -s -o /dev/null -w "%{http_code}" \
    "$BASE_URL/api/files?space=shared:${SHARE_ID}" -b "$BOB_SESSION")
  if [[ "$REVOKED" == "404" ]]; then
    echo "PASS bob's shared space returns 404 after revocation"
  else
    echo "FAIL expected 404 after revocation, got $REVOKED"
    FAILED=1
  fi
fi
AFTER=$(curl -s "$BASE_URL/api/shares" -b "$ALICE_SESSION")
if grep -q '"folder":"projects/"' <<<"$AFTER"; then
  echo "FAIL revoked share still listed: $AFTER"
  FAILED=1
else
  echo "PASS owner listing no longer shows the revoked share"
fi

exit "$FAILED"
