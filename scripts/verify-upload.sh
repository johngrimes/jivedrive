#!/usr/bin/env bash
# Verify the upload URL flow (User Story 3) against a running server with a
# mocked S3 layer. Boots the e2e server (seeded in-memory DB + in-memory
# mock object store) and exercises POST /api/files/upload-url with curl.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="http://localhost:5173"
SESSION="jivedrive_session=browse-session"
FAILED=0

# Refuse to clobber a server that is already listening on 5173.
if curl -sf "$BASE_URL/healthcheck" >/dev/null 2>&1; then
  echo "A server is already running on $BASE_URL; stop it first." >&2
  exit 1
fi

# Start the e2e server (seeded DB + mock S3) in the background.
bun run backend/src/e2eServer.ts &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

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
  local label="$1" expected="$2" method="$3" path="$4" data="$5"
  local tmp code body
  tmp=$(mktemp)
  local args=(
    -s -o "$tmp" -w "%{http_code}" -X "$method" "$BASE_URL$path"
    -b "$SESSION" -H "Content-Type: application/json"
  )
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

check "new file in docs (name with spaces and # and ?)" 200 POST \
  /api/files/upload-url \
  '{"folder":"docs","fileName":"brand new #1?.txt","overwrite":false}'
check "existing file without overwrite" 409 POST /api/files/upload-url \
  '{"folder":"","fileName":"report.pdf","overwrite":false}'
check "existing file with overwrite" 200 POST /api/files/upload-url \
  '{"folder":"","fileName":"report.pdf","overwrite":true}'
check "folder escaping the user's space" 400 POST /api/files/upload-url \
  '{"folder":"../bob","fileName":"x.txt","overwrite":false}'
check "file name containing a slash" 400 POST /api/files/upload-url \
  '{"folder":"","fileName":"a/b.txt","overwrite":false}'
check "missing overwrite flag" 400 POST /api/files/upload-url \
  '{"folder":"","fileName":"a.txt"}'
check "empty folder uses the user prefix root" 200 POST /api/files/upload-url \
  '{"folder":"","fileName":"root file.txt","overwrite":false}'

# Key and URL shape for the encoded name: stored verbatim, URL-encoded in
# the presigned URL, short 15-minute expiry.
NEW=$(curl -s -X POST "$BASE_URL/api/files/upload-url" -b "$SESSION" \
  -H "Content-Type: application/json" \
  -d '{"folder":"docs","fileName":"brand new #1?.txt","overwrite":false}')
if grep -q '"key":"users/alice/docs/brand new #1?.txt"' <<<"$NEW"; then
  echo "PASS key stores the file name verbatim"
else
  echo "FAIL key was not stored verbatim: $NEW"
  FAILED=1
fi
if grep -q 'brand%20new%20%231%3F.txt' <<<"$NEW"; then
  echo "PASS presigned URL URL-encodes the name"
else
  echo "FAIL presigned URL did not encode the name: $NEW"
  FAILED=1
fi
if grep -q 'X-Amz-Expires=900' <<<"$NEW"; then
  echo "PASS presigned URL is short-lived (15 minutes)"
else
  echo "FAIL presigned URL expiry missing: $NEW"
  FAILED=1
fi

# The presigned URL accepts the PUT and the file appears in the listing.
UPLOAD_URL=$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' <<<"$NEW")
PUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$UPLOAD_URL" \
  -d "verification payload")
echo "PUT to presigned URL -> HTTP $PUT_CODE"
LIST=$(curl -s "$BASE_URL/api/files?prefix=docs" -b "$SESSION")
if grep -q 'brand new #1?.txt' <<<"$LIST"; then
  echo "PASS uploaded file appears in the docs listing"
else
  echo "FAIL uploaded file missing from listing: $LIST"
  FAILED=1
fi

# An unsigned request is refused.
UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$BASE_URL/api/files/upload-url" -H "Content-Type: application/json" \
  -d '{"folder":"","fileName":"a.txt","overwrite":false}')
if [[ "$UNAUTH_CODE" == "401" ]]; then
  echo "PASS unsigned request refused with 401"
else
  echo "FAIL unsigned request got HTTP $UNAUTH_CODE"
  FAILED=1
fi

exit "$FAILED"
