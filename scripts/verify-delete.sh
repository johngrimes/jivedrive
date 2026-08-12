#!/usr/bin/env bash
# Verify the delete flow (User Story 5) against a running server with a
# mocked S3 layer. Boots the e2e server on port 5175 with a file-backed
# SQLite database and in-memory mock object store, then exercises
# DELETE /api/files with curl: existing object -> 204 and gone from the
# listing, delete again -> 404, out-of-scope key -> 400, unsigned -> 401,
# and confirms no database rows change.
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="http://localhost:5175"
SESSION="jivedrive_session=browse-session"
DB_FILE="$(mktemp -u /tmp/jivedrive-delete-verify.XXXXXX.db)"
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
  local label="$1" expected="$2" path="$3" auth="${4:-}"
  local tmp code body
  tmp=$(mktemp)
  local args=(-s -o "$tmp" -w "%{http_code}" -X DELETE "$BASE_URL$path")
  if [[ "$auth" == "signed" ]]; then args+=(-b "$SESSION"); fi
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

# The object exists (seeded in the mock store), so the delete succeeds
# with 204 and no body.
check "delete an existing object" 204 \
  "/api/files?key=users%2Falice%2Fphotos%2Fdelete-me-confirm.txt" signed

# The object is gone from the listing.
LIST=$(curl -s "$BASE_URL/api/files?prefix=photos" -b "$SESSION")
if grep -q 'delete-me-confirm.txt' <<<"$LIST"; then
  echo "FAIL deleted object still present in the listing: $LIST"
  FAILED=1
else
  echo "PASS deleted object is gone from the listing"
fi

# Deleting the same key again reports 404 (object does not exist).
check "delete the same key again (missing object)" 404 \
  "/api/files?key=users%2Falice%2Fphotos%2Fdelete-me-confirm.txt" signed

# A key outside the user's prefix is refused with 400.
check "key outside the user's space" 400 \
  "/api/files?key=users%2Fbob%2Fa.txt" signed
check "key sharing only a name prefix" 400 \
  "/api/files?key=users%2Falice2%2Fa.txt" signed

# A missing key parameter is refused with 400.
check "missing key parameter" 400 "/api/files" signed

# An unsigned request is refused with 401.
check "unsigned request refused" 401 \
  "/api/files?key=users%2Falice%2Fphotos%2Fdelete-me-cancel.txt"

AFTER=$(counts)
echo "DB row counts after  (users,credentials,invites,sessions): $AFTER"
if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "PASS nothing persisted: deleting an object never touches the database"
else
  echo "FAIL the delete changed the database: $BEFORE -> $AFTER"
  FAILED=1
fi

exit "$FAILED"
