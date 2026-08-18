#!/usr/bin/env bash
# Verify the hardened Helm chart output (User Story 7). Renders the chart
# with helm template and asserts the container securityContext (read-only
# rootfs, no privilege escalation, dropped capabilities, RuntimeDefault
# seccomp), non-empty resource requests/limits, the writable /data mount,
# and the /tmp emptyDir scratch mount. Exits non-zero with a message naming
# the first missing assertion; prints PASS on success.
#
# Usage: scripts/verify-helm-hardening.sh [chart-dir]
#   chart-dir defaults to deploy/helm/jivedrive (repo-relative).
set -euo pipefail

CHART_DIR="${1:-deploy/helm/jivedrive}"
cd "$(dirname "$0")/.."

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT

helm template "$CHART_DIR" >"$RENDERED"

FAILED=0
fail() {
  echo "FAIL $1" >&2
  FAILED=1
}
pass() {
  echo "PASS $1"
}

# --- Container securityContext -------------------------------------------
if grep -q 'readOnlyRootFilesystem: true' "$RENDERED"; then
  pass "readOnlyRootFilesystem: true"
else
  fail "readOnlyRootFilesystem: true is missing from the rendered deployment"
fi

if grep -q 'allowPrivilegeEscalation: false' "$RENDERED"; then
  pass "allowPrivilegeEscalation: false"
else
  fail "allowPrivilegeEscalation: false is missing from the rendered deployment"
fi

if grep -q '^ *capabilities:' "$RENDERED" &&
  grep -q '^ *drop:' "$RENDERED" &&
  grep -q -- '- ALL' "$RENDERED"; then
  pass "capabilities: drop: [- ALL]"
else
  fail "capabilities: drop: [- ALL] is missing from the rendered deployment"
fi

if grep -q '^ *seccompProfile:' "$RENDERED" &&
  grep -q 'type: RuntimeDefault' "$RENDERED"; then
  pass "seccompProfile: type: RuntimeDefault"
else
  fail "seccompProfile: type: RuntimeDefault is missing from the rendered deployment"
fi

# --- Resources -----------------------------------------------------------
# The container resources block is the top-level (10-space indent)
# `resources:` key; it must carry both requests and limits with a value
# under each. It renders either as inline JSON (the values.yaml defaults,
# e.g. resources: {"requests":{...},"limits":{...}}) or as a multi-line
# YAML block (operator overrides). The PVC's own resources block
# (requests.storage) is deliberately not counted.
RESOURCES_OK=$(awk '
  /^ {10}resources:/ {
    if ($0 ~ /"requests":/ && $0 ~ /"limits":/) {
      have_requests = 1; have_limits = 1
      requests_value = 1; limits_value = 1
    }
    in_resources = 1
    next
  }
  in_resources && !/^[[:space:]]*$/ {
    match($0, /^ */)
    indent = RLENGTH
    if (indent <= 10) exit
    if ($0 ~ /^ {12}requests:/) { have_requests = 1; requests_value = 0 }
    else if ($0 ~ /^ {12}limits:/) { have_limits = 1; limits_value = 0 }
    else if (indent >= 14) {
      if (have_requests && !requests_value) requests_value = 1
      if (have_limits && !limits_value) limits_value = 1
    }
  }
  END {
    if (have_requests && requests_value && have_limits && limits_value) print "ok"
  }
' "$RENDERED")

if [[ "$RESOURCES_OK" == "ok" ]]; then
  pass "resources: non-empty requests and limits"
else
  fail "container resources must have non-empty requests and limits"
fi

# --- Mounts --------------------------------------------------------------
# /tmp is served by a dedicated emptyDir volume: the volumes-list entry
# `- name: tmp` (8-space indent) must be followed by `emptyDir: {}`.
TMP_EMPTYDIR_OK=$(awk '
  /^ {8}- name: tmp/ { want_empty_dir = 1; next }
  want_empty_dir && !/^[[:space:]]*$/ {
    if ($0 ~ /^ {10}emptyDir: \{\}/) print "ok"
    exit
  }
' "$RENDERED")

if grep -q 'mountPath: /tmp' "$RENDERED" && [[ "$TMP_EMPTYDIR_OK" == "ok" ]]; then
  pass "/tmp mounted from an emptyDir"
else
  fail "/tmp emptyDir mount is missing from the rendered deployment"
fi

if grep -Eq 'mountPath: "?/data"?' "$RENDERED"; then
  pass "writable /data mount (SQLite volume)"
else
  fail "/data mount is missing from the rendered deployment"
fi

if [[ "$FAILED" == "0" ]]; then
  echo "All Helm hardening assertions passed."
fi

exit "$FAILED"
