#!/usr/bin/env bash
# Verify the share link flow (User Story 4) against a running server with a
# mocked S3 layer. Boots the e2e server on port 5174 with a file-backed
# SQLite database and in-memory mock object store, then exercises
# POST /api/files/share-url with curl, checks that nothing is persisted,
# and downloads the file anonymously via a generated link.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="http://localhost:5174"
SESSION="jivedrive_session=browse-session"
DB_FILE="$(mktemp -u /tmp/jivedrive-share-verify.XXXXXX.db)"
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

# Row counts per table, read from the server's SQLite file.
counts() {
  DB_FILE="$DB_FILE" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.DB_FILE, { readonly: true });
    const tables = ["users", "passkey_credentials", "invites", "sessions"];
    console.log(
      tables
        .map((t) => db.query(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
        .join(","),
    );
  '
}

check() {
  local label="$1" expected="$2" method="$3" path="$4" data="$5" auth="${6:-}"
  local tmp code body
  tmp=$(mktemp)
  local args=(-s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path"
    -H "Content-Type: application/json")
  if [[ "$auth" == "signed" ]]; then args+=(-b "$SESSION"); fi
  if [[ -n "$data" ]]; then args+=(-d "$data"); fi
  code=$(curl "${args[@]}")
  body=$(cat "$tmp")
  rm -f "$tmp"
  if [[ "$code" == "$expected" ]]; then
    printf 'PASS %-46s HTTP %s %s\n' "$label" "$code" "$body"
  else
    printf 'FAIL %-46s expected HTTP %s, got %s %s\n' "$label" "$expected" "$code" "$body"
    FAILED=1
  fi
}

BEFORE=$(counts)
echo "DB row counts before (users,credentials,invites,sessions): $BEFORE"

check "default 7-day expiry" 200 POST /api/files/share-url \
  '{"key":"users/alice/readme.md"}' signed
check "1 hour override" 200 POST /api/files/share-url \
  '{"key":"users/alice/readme.md","expiresIn":"1h"}' signed
check "24 hours override" 200 POST /api/files/share-url \
  '{"key":"users/alice/readme.md","expiresIn":"24h"}' signed
check "30 days override" 200 POST /api/files/share-url \
  '{"key":"users/alice/readme.md","expiresIn":"30d"}' signed
check "key outside the user's space" 400 POST /api/files/share-url \
  '{"key":"users/bob/a.txt"}' signed
check "invalid expiresIn" 400 POST /api/files/share-url \
  '{"key":"users/alice/readme.md","expiresIn":"2h"}' signed
check "missing key" 400 POST /api/files/share-url '{}' signed
check "unsigned request refused" 401 POST /api/files/share-url \
  '{"key":"users/alice/readme.md"}'

AFTER=$(counts)
echo "DB row counts after  (users,credentials,invites,sessions): $AFTER"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "PASS nothing persisted: the share route never writes to the database"
else
  echo "FAIL the share route changed the database: $BEFORE -> $AFTER"
  FAILED=1
fi

# URL shape checks: default carries X-Amz-Expires=604800 and an expiresAt.
DEFAULT=$(curl -s -X POST "$BASE_URL/api/files/share-url" -b "$SESSION" \
  -H "Content-Type: application/json" -d '{"key":"users/alice/readme.md"}')
if grep -q 'X-Amz-Expires=604800' <<<"$DEFAULT"; then
  echo "PASS default link carries the 7-day expiry (X-Amz-Expires=604800)"
else
  echo "FAIL default link expiry missing: $DEFAULT"
  FAILED=1
fi
if grep -q '"expiresAt":"' <<<"$DEFAULT"; then
  echo "PASS default link carries an expiresAt timestamp"
else
  echo "FAIL default link has no expiresAt: $DEFAULT"
  FAILED=1
fi

# 1-hour override carries X-Amz-Expires=3600.
HOUR=$(curl -s -X POST "$BASE_URL/api/files/share-url" -b "$SESSION" \
  -H "Content-Type: application/json" \
  -d '{"key":"users/alice/readme.md","expiresIn":"1h"}')
if grep -q 'X-Amz-Expires=3600' <<<"$HOUR"; then
  echo "PASS 1-hour link carries X-Amz-Expires=3600"
else
  echo "FAIL 1-hour link expiry missing: $HOUR"
  FAILED=1
fi

# The generated link downloads the file with no JiveDrive session: the
# mock S3 server has no auth, mirroring S3's public presigned behaviour.
URL=$(curl -s -X POST "$BASE_URL/api/files/share-url" -b "$SESSION" \
  -H "Content-Type: application/json" \
  -d '{"key":"users/alice/data.csv","expiresIn":"1h"}')
LINK=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' <<<"$URL")
BODY=$(curl -s "$LINK")
if [[ "$BODY" == $'a,b,c\n1,2,3' ]]; then
  echo "PASS anonymous GET of the link downloads the file bytes"
else
  echo "FAIL anonymous GET returned: $BODY"
  FAILED=1
fi

exit "$FAILED"
