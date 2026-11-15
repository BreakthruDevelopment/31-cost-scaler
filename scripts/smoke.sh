#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP: one creates a scenario (idempotently), the other can't see or change it.
# CI seeds the footprint first (pnpm seed:footprint); the deployed app imports it itself.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

# Better Auth allows 3 sign-in/sign-up requests per 10 s per IP. Back-to-back runs (smoke right after seeding, or two
# users in a row) can hit it. On a 429, wait out the window and retry once.
post_auth() {
  local jar=$1 path=$2 payload=$3 code
  for attempt in 1 2; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "$payload" "$BASE_URL$path")
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      echo "auth rate limit (429) on $path; waiting 11s and retrying once"
      sleep 11
      continue
    fi
    break
  done
  case "$code" in 2??) return 0 ;; *) echo "auth request to $path returned $code" >&2; return 1 ;; esac
}

signup() {
  local jar=$1 email=$2
  post_auth "$jar" /api/auth/sign-up/email "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

SPEC='{"users":{"mau":500,"requestsPerUser":200},"compute":{"kind":"serverless","instances":1,"vcpu":1,"memoryGb":0.5,"busyFraction":0.1},"containers":{"count":0,"vcpu":0.25,"memoryGb":0.5,"busyFraction":0.1},"database":{"vcpu":1,"memoryGb":1,"storageGb":20,"readReplicas":0},"storage":{"objectGb":10,"egressGb":20},"identity":{"mau":500},"loadBalancers":0}'
id_of() { sed -E 's/.*"scenario":\{"id":"([^"]+)".*/\1/'; }
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# Public data
footprint=$(curl -fsS "$BASE_URL/api/footprint") || fail "GET /api/footprint failed"
echo "$footprint" | grep -q '"name":"' || fail "/api/footprint lists no apps (CI seeds them with pnpm seed:footprint): $footprint"
pass "public footprint lists apps"
prices=$(curl -fsS "$BASE_URL/api/prices") || fail "GET /api/prices failed"
for cloud in aws azure gcp oci; do
  echo "$prices" | grep -q "\"cloud\":\"$cloud\"" || fail "/api/prices has no $cloud rows (CI seeds them with pnpm seed:prices)"
done
pass "public price table has rows for all four clouds"
[ "$(curl -fsS "$BASE_URL/api/prices?cloud=oci" | grep -c '"cloud":"aws"')" = "0" ] || fail "/api/prices?cloud=oci returned other clouds"
[ "$(status "$BASE_URL/api/prices?cloud=mars")" = "400" ] || fail "an unknown cloud filter should be 400"
pass "price filters work and validate"

# Signed-out and admin-only
[ "$(status "$BASE_URL/api/scenarios")" = "401" ] || fail "anonymous scenario list should be 401"
[ "$(status "$BASE_URL/api/admin/stats")" = "401" ] || fail "anonymous admin stats should be 401"
[ "$(status -b "$JAR_A" "$BASE_URL/api/admin/stats")" = "403" ] || fail "a plain user's admin stats should be 403"
pass "anonymous access refused; admin stats are admin only"

# Price refresh is closed to the public
[ "$(status -X POST -H "origin: $BASE_URL" "$BASE_URL/api/prices/refresh")" = "401" ] || fail "unauthenticated refresh should be 401"
[ "$(status -X POST "$BASE_URL/api/prices/refresh")" = "401" ] || fail "unauthenticated refresh without an Origin should be 401"
[ "$(status -X POST -H 'authorization: Bearer not-the-token' "$BASE_URL/api/prices/refresh")" = "401" ] || fail "a wrong bearer token should be 401"
[ "$(status -X POST -H 'authorization: Bearer ' "$BASE_URL/api/prices/refresh")" = "401" ] || fail "an empty bearer token should be 401"
[ "$(status -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/prices/refresh")" = "403" ] || fail "a plain user's refresh should be 403"
[ "$(status -X POST -b "$JAR_A" -H 'authorization: Bearer not-the-token' -H "origin: $BASE_URL" "$BASE_URL/api/prices/refresh")" = "401" ] || fail "a wrong bearer must not fall back to the session"
pass "price refresh: no credentials 401, wrong bearer 401, plain user 403"

# Hostile writes
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "{\"name\":\"x\",\"spec\":$SPEC}" "$BASE_URL/api/scenarios")" = "403" ] || fail "cross-origin create should be 403"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -d "{\"name\":\"x\",\"spec\":$SPEC}" "$BASE_URL/api/scenarios")" = "403" ] || fail "create without an Origin should be 403"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{nope' "$BASE_URL/api/scenarios")" = "400" ] || fail "malformed JSON should be 400"
code=$(head -c 40000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" --data-binary @- "$BASE_URL/api/scenarios")
[ "$code" = "413" ] || fail "oversized body should be 413, got $code"
pass "cross-origin, malformed and oversized writes refused"

[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"name\":\"nul\\u0000byte\",\"spec\":$SPEC}" "$BASE_URL/api/scenarios")" = "400" ] || fail "a NUL byte in a name should be 400"
[ "$(status -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"name":"bad spec","spec":{"users":{"mau":99999999,"requestsPerUser":1}}}' "$BASE_URL/api/scenarios")" = "400" ] || fail "an out-of-range spec should be 400"
pass "NUL byte and bad spec rejected with 400, not 500"

# A creates a scenario; the same client op id again is the same row
op="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)"
body="{\"name\":\"smoke scenario $RUN_ID\",\"spec\":$SPEC,\"clientOpId\":\"$op\"}"
first=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL/api/scenarios") || fail "create scenario failed"
second=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL/api/scenarios") || fail "idempotent replay failed"
sid=$(echo "$first" | id_of)
[ -n "$sid" ] && [ "$sid" != "$first" ] || fail "no scenario id in $first"
[ "$sid" = "$(echo "$second" | id_of)" ] || fail "a replayed client op id must return the first scenario: $first vs $second"
count=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/scenarios" | grep -o "\"id\":\"$sid\"" | wc -l)
[ "$count" = "1" ] || fail "replaying a client op id must leave one row, found $count"
pass "user A created a scenario; a replayed client op id made one row"

# A prices the scenario on all four clouds (CI seeds a price fixture with pnpm seed:prices)
[ "$(status -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"spec\":$SPEC}" "$BASE_URL/api/price")" = "401" ] || fail "anonymous POST /api/price should be 401"
[ "$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "{\"spec\":$SPEC}" "$BASE_URL/api/price")" = "403" ] || fail "cross-origin POST /api/price should be 403"
[ "$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"spec":{"users":{"mau":99999999,"requestsPerUser":1}}}' "$BASE_URL/api/price")" = "400" ] || fail "an out-of-range spec on /api/price should be 400"
priced=$(curl -fsS -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"spec\":$SPEC}" "$BASE_URL/api/price") || fail "POST /api/price failed"
[ "$(echo "$priced" | grep -o '"totalMicros"' | wc -l)" = "4" ] || fail "pricing should return four cloud totals: $priced"
echo "$priced" | grep -Eq '"cheapest":"(aws|azure|gcp|oci)"' || fail "pricing should set a cheapest cloud (is the price fixture seeded?): $priced"
for cloud in aws azure gcp oci; do echo "$priced" | grep -q "\"cloud\":\"$cloud\"" || fail "pricing result has no $cloud"; done
pass "user A priced a scenario on four clouds and the cheapest is set"

# "Should this app move?": public at the 10x preset; a scenario only for its owner
move=$(curl -fsS "$BASE_URL/api/move?app=build-tracker&to=gcp") || fail "public GET /api/move failed"
echo "$move" | grep -Eq '"verdict":"(move|consider|stay|not_enough_data|blocked)"' || fail "move advice has no verdict: $move"
[ "$(status "$BASE_URL/api/move?app=build-tracker&to=gcp&scenario=$sid")" = "401" ] || fail "move with a scenario, signed out, should be 401"
mine=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/move?app=build-tracker&to=gcp&scenario=$sid") || fail "owner move with scenario failed"
echo "$mine" | grep -q '"basis":"scenario"' || fail "owner move should use the scenario: $mine"
[ "$(status -b "$JAR_B" "$BASE_URL/api/move?app=build-tracker&to=gcp&scenario=$sid")" = "404" ] || fail "user B's move on A's scenario should be 404"
[ "$(status "$BASE_URL/api/move?app=build-tracker&to=mars")" = "400" ] || fail "an unknown cloud on /api/move should be 400"
pass "move advice: public preset, owner-only scenario (B gets 404)"

# B can't see or change it
[ "$(status -b "$JAR_B" "$BASE_URL/api/scenarios/$sid")" = "404" ] || fail "user B reading A's scenario should be 404"
[ "$(status -X PATCH -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"name":"hijack"}' "$BASE_URL/api/scenarios/$sid")" = "404" ] || fail "user B patching A's scenario should be 404"
[ "$(status -X DELETE -b "$JAR_B" -H "origin: $BASE_URL" "$BASE_URL/api/scenarios/$sid")" = "404" ] || fail "user B deleting A's scenario should be 404"
curl -fsS -b "$JAR_B" "$BASE_URL/api/scenarios" | grep -q "$sid" && fail "A's scenario appeared in B's list"
pass "user B gets 404 on A's scenario and never sees it listed"

# The scaling advisor (demo answers in CI: a scripted run of the real tools). Signed-in only; own scenarios only.
ASK='{"question":"Should build-tracker move at ten times the users?","app":"build-tracker"}'
[ "$(status -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$ASK" "$BASE_URL/api/advice")" = "401" ] || fail "anonymous POST /api/advice should be 401"
[ "$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$ASK" "$BASE_URL/api/advice")" = "403" ] || fail "cross-origin POST /api/advice should be 403"
[ "$(status -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"question":"nul\u0000byte"}' "$BASE_URL/api/advice")" = "400" ] || fail "a NUL byte in a question should be 400"
[ "$(status -X POST -b "$JAR_B" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"question\":\"What about this?\",\"scenarioId\":\"$sid\"}" "$BASE_URL/api/advice")" = "404" ] || fail "user B asking about A's scenario should be 404"
advice=$(curl -fsS -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "{\"question\":\"Should build-tracker move?\",\"app\":\"build-tracker\",\"scenarioId\":\"$sid\"}" "$BASE_URL/api/advice") || fail "POST /api/advice failed"
echo "$advice" | grep -Eq '"recommendation":"(move|consider|stay|not_enough_data|blocked)"' || fail "the advisor answer has no recommendation: $advice"
echo "$advice" | grep -q '"droppedFigures":\[\]' || fail "the demo answer had a figure that failed its check: $advice"
curl -fsS -b "$JAR_A" "$BASE_URL/api/advice" | grep -q '"question":"Should build-tracker move?"' || fail "A's advice missing from A's history"
curl -fsS -b "$JAR_B" "$BASE_URL/api/advice" | grep -q 'build-tracker' && fail "A's advice appeared in B's history"
pass "advisor: signed-in only, B gets 404 on A's scenario, the answer is checked and stored for A alone"

# Versioned update
patched=$(curl -fsS -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"name":"smoke renamed"}' "$BASE_URL/api/scenarios/$sid") || fail "owner PATCH failed"
echo "$patched" | grep -q '"version":2' || fail "PATCH should bump the version: $patched"
[ "$(status -X PATCH -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{"version":1,"name":"stale"}' "$BASE_URL/api/scenarios/$sid")" = "409" ] || fail "a stale version should be 409"
pass "versioned update: current version ok, stale version 409"

[ "$(status -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/scenarios/$sid")" = "204" ] || fail "owner delete should be 204"
[ "$(status -b "$JAR_A" "$BASE_URL/api/scenarios/$sid")" = "404" ] || fail "a deleted scenario should be 404"
pass "owner deleted their scenario"

echo "SMOKE PASS"
