#!/usr/bin/env bash
# E2E API tests against the server running in demo mode.
# Usage: ./e2e/demo-api-test.sh
# Expects DEMO_AUTOSTART=true and the server to be started externally,
# OR starts the server itself if not already running.

set -euo pipefail

PORT="${PORT:-3000}"
BASE_URL="${BASE_URL:-http://localhost:$PORT}"
PASS=0
FAIL=0
PIDS_TO_KILL=()

cleanup() {
  for pid in "${PIDS_TO_KILL[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ── Helper ──────────────────────────────────────────────────────────────
assert_status() {
  local desc="$1" method="$2" path="$3" expected="$4"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE_URL$path")
  if [ "$status" -eq "$expected" ]; then
    echo "  ✅ $desc (HTTP $status)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — expected $expected, got $status"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local desc="$1" path="$2" field="$3"
  local body
  body=$(curl -s "$BASE_URL$path")
  if echo "$body" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.exit(d.hasOwnProperty('$field') ? 0 : 1);
  " 2>/dev/null; then
    echo "  ✅ $desc (field '$field' present)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc — field '$field' missing"
    FAIL=$((FAIL + 1))
  fi
}

# ── Start server if needed ──────────────────────────────────────────────
if ! curl -sf "$BASE_URL/api/health" >/dev/null 2>&1; then
  echo "Starting server in demo mode..."
  DEMO_AUTOSTART=true npx tsx server/index.ts &
  PIDS_TO_KILL+=($!)

  # Poll until healthy (max 30s)
  for i in $(seq 1 30); do
    if curl -sf "$BASE_URL/api/health" >/dev/null 2>&1; then
      echo "Server ready after ${i}s"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "❌ Server did not start within 30s"
      exit 1
    fi
    sleep 1
  done
fi

# ── Tests ───────────────────────────────────────────────────────────────
echo ""
echo "=== E2E Demo-Mode API Tests ==="
echo ""

echo "Health & Status:"
assert_status "GET /api/health → 200" GET "/api/health" 200
assert_json_field "health has 'status'" "/api/health" "status"
assert_json_field "health has 'version'" "/api/health" "version"
assert_json_field "health has 'uptime'" "/api/health" "uptime"

assert_status "GET /api/status → 200" GET "/api/status" 200
assert_json_field "status has 'settings'" "/api/status" "settings"
assert_json_field "status has 'controls'" "/api/status" "controls"
assert_json_field "status has 'timestamp'" "/api/status" "timestamp"
assert_json_field "status has 'buildInfo'" "/api/status" "buildInfo"

echo ""
echo "Settings & Build Info:"
assert_status "GET /api/settings → 200" GET "/api/settings" 200
assert_status "GET /api/build-info → 200" GET "/api/build-info" 200
assert_json_field "build-info has 'version'" "/api/build-info" "version"

echo ""
echo "Wallbox:"
assert_status "GET /api/wallbox/status → 200" GET "/api/wallbox/status" 200

echo ""
echo "Controls & Logs:"
assert_status "GET /api/controls → 200" GET "/api/controls" 200
assert_status "GET /api/logs → 200" GET "/api/logs" 200

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
