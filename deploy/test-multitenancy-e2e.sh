#!/usr/bin/env bash
# TownBrief multitenancy end-to-end integration test.
#
# Runs against a live dev stack (compose.dev.yaml). Probes every layer
# we've shipped — single sign-in, cross-site SSO, mirror-user provisioning,
# is_superadmin permission bypass, signout propagation, RLS isolation,
# render isolation across hosts.
#
# Exits non-zero on the FIRST failed assertion. Each test prints a
# one-line PASS/FAIL. Lib functions only — no Mocha/Jest dep.
#
# Usage:
#   ./deploy/test-multitenancy-e2e.sh
#
# Assumes:
#   - dev stack up (docker compose -f compose.dev.yaml up -d)
#   - default site has user dave@waylandpost.org / TownBrief2026!
#   - sites: default, wayland, concord, lex (slugs)
#   - hosts resolved via --resolve flag (localtest.me wildcard or hardcoded)
set -uo pipefail

# Hosts the dev stack uses. localtest.me + the wildcard CNAME means
# any subdomain resolves to 127.0.0.1, but we --resolve explicitly so
# the test doesn't depend on DNS.
DEFAULT_HOST="localhost"
WAYLAND_HOST="wayland.localtest.me"
CONCORD_HOST="concord.localtest.me"
LEX_HOST="lex.localtest.me"

# Site ids from the dev DB. If these change, update here. They're
# stable because they're seeded once.
WAYLAND_ID="6a39b527980d7f0060a0eeef"
CONCORD_ID="6a39e6f1af11d612ef48e431"
LEX_ID="6a39e77b31fade134f4b55a8"

CREDS_USER="dave@waylandpost.org"
CREDS_PASS="TownBrief2026!"

# --- Output + counters ---------------------------------------------------
PASS=0
FAIL=0
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
say()   { printf '\033[36m%s\033[0m\n' "$*"; }

assert_eq() {
    local expected="$1" actual="$2" msg="$3"
    if [[ "$expected" == "$actual" ]]; then
        green "  PASS: $msg"
        PASS=$((PASS+1))
    else
        red "  FAIL: $msg (expected '$expected', got '$actual')"
        FAIL=$((FAIL+1))
    fi
}

assert_contains() {
    local needle="$1" haystack="$2" msg="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        green "  PASS: $msg"
        PASS=$((PASS+1))
    else
        red "  FAIL: $msg (no '$needle' in body)"
        FAIL=$((FAIL+1))
    fi
}

assert_not_contains() {
    local needle="$1" haystack="$2" msg="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        green "  PASS: $msg"
        PASS=$((PASS+1))
    else
        red "  FAIL: $msg (unexpected '$needle' in body)"
        FAIL=$((FAIL+1))
    fi
}

# --- HTTP helpers --------------------------------------------------------
# All target the dev gateway on :80. --resolve forces the hostname to
# 127.0.0.1 so we don't depend on the localtest.me DNS wildcard.
http() {
    local host="$1" method="$2" path="$3" jar="${4:-/dev/null}" body="${5:-}" status_only="${6:-0}"
    local data_arg=()
    [[ -n "$body" ]] && data_arg=(-d "$body")
    if [[ "$status_only" == "1" ]]; then
        curl -sS -o /dev/null -w "%{http_code}" \
            -b "$jar" -c "$jar" \
            --resolve "$host:80:127.0.0.1" \
            -X "$method" -H "Origin: http://$host" -H "Content-Type: application/json" \
            "${data_arg[@]}" "http://$host$path"
    else
        curl -sS \
            -b "$jar" -c "$jar" \
            --resolve "$host:80:127.0.0.1" \
            -X "$method" -H "Origin: http://$host" -H "Content-Type: application/json" \
            "${data_arg[@]}" "http://$host$path"
    fi
}

http_status() { http "$1" "$2" "$3" "${4:-/dev/null}" "${5:-}" 1; }
http_body() { http "$1" "$2" "$3" "${4:-/dev/null}" "${5:-}" 0; }

mailpit_latest_code() {
    # Parses the most recent Mailpit message subject for a 6-digit code.
    # Used when 2FA is on (which it shouldn't be in dev).
    curl -sS "http://localhost:8025/api/v1/messages?limit=1" \
        | grep -oE '"Subject":"[0-9]{6}' | head -1 | grep -oE '[0-9]{6}'
}

# --- Sanity ---------------------------------------------------------------
say ""
say "==================================================="
say " TownBrief multitenancy E2E test suite"
say "==================================================="
say ""
say "STEP 0: stack sanity"

assert_eq "200" "$(http_status $DEFAULT_HOST GET /ghost/api/admin/site/)" "default /site/ reachable"
assert_eq "200" "$(http_status $WAYLAND_HOST GET /ghost/api/admin/site/)" "wayland /site/ reachable"
assert_eq "200" "$(http_status $CONCORD_HOST GET /ghost/api/admin/site/)" "concord /site/ reachable"
assert_eq "200" "$(http_status $LEX_HOST GET /ghost/api/admin/site/)" "lex /site/ reachable"

# --- 1. Sign-in (no 2FA in dev) ------------------------------------------
say ""
say "STEP 1: sign in on default (one-step, no 2FA)"
JAR_DEFAULT="$(mktemp)"
SIGNIN_STATUS="$(http_status $DEFAULT_HOST POST /ghost/api/admin/session/ $JAR_DEFAULT "{\"username\":\"$CREDS_USER\",\"password\":\"$CREDS_PASS\"}")"
assert_eq "201" "$SIGNIN_STATUS" "signin returns 201"

# Probe protected endpoint
ME_STATUS="$(http_status $DEFAULT_HOST GET /ghost/api/admin/users/me/ $JAR_DEFAULT)"
assert_eq "200" "$ME_STATUS" "/users/me/ accessible after signin"

# is_superadmin should be true
ME_BODY="$(http_body $DEFAULT_HOST GET /ghost/api/admin/users/me/ $JAR_DEFAULT)"
assert_contains '"is_superadmin":true' "$ME_BODY" "user is flagged superadmin"

# --- 2. Sites endpoint (Phase 5a/9 — picker source data) -----------------
say ""
say "STEP 2: sites picker endpoint"
SITES_STATUS="$(http_status $DEFAULT_HOST GET /ghost/api/admin/sites/ $JAR_DEFAULT)"
assert_eq "200" "$SITES_STATUS" "/sites/ returns 200 for superadmin"
SITES_BODY="$(http_body $DEFAULT_HOST GET /ghost/api/admin/sites/ $JAR_DEFAULT)"
assert_contains '"slug":"wayland"' "$SITES_BODY" "wayland in sites list"
assert_contains '"slug":"concord"' "$SITES_BODY" "concord in sites list"
assert_contains '"slug":"lexington"' "$SITES_BODY" "lexington in sites list"
assert_contains '"is_superadmin":true' "$SITES_BODY" "meta carries is_superadmin"

# --- 3. SSO mint endpoint (Phase 5d) -------------------------------------
say ""
say "STEP 3: cross-site SSO mint"
MINT_STATUS="$(http_status $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{\"site_id\":\"$WAYLAND_ID\"}")"
assert_eq "200" "$MINT_STATUS" "mint returns 200 for valid superadmin + valid site"

MINT_BODY="$(http_body $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{\"site_id\":\"$WAYLAND_ID\"}")"
assert_contains "wayland.localtest.me" "$MINT_BODY" "redirect_url targets wayland host"
assert_contains "sso-redeem?token=" "$MINT_BODY" "redirect_url is the redeem endpoint"
assert_contains "http://" "$MINT_BODY" "scheme inferred from Origin (http, not https)"

# Bad site id
BAD_MINT_STATUS="$(http_status $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{\"site_id\":\"does000not000exist00000\"}")"
assert_eq "404" "$BAD_MINT_STATUS" "mint 404s for non-existent target site"

# Missing site id
MISSING_MINT_STATUS="$(http_status $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{}")"
assert_eq "400" "$MISSING_MINT_STATUS" "mint 400s when site_id missing"

# Unauth call
UNAUTH_JAR="$(mktemp)"
UNAUTH_MINT_STATUS="$(http_status $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $UNAUTH_JAR "{\"site_id\":\"$WAYLAND_ID\"}")"
# Ghost's mw.authAdminApi returns 403 NoPermissionError for missing session
# (not 401 — the historical Ghost convention is "you have no permission to
# act without auth" rather than the more strictly-correct 401).
assert_eq "403" "$UNAUTH_MINT_STATUS" "mint 403s when not signed in (Ghost auth middleware convention)"
rm -f "$UNAUTH_JAR"

# --- 4. SSO redeem on each peer (Phase 5d) -------------------------------
say ""
say "STEP 4: redeem on each peer site (mirror user created + session activated)"
JAR_WAYLAND="$(mktemp)"
JAR_CONCORD="$(mktemp)"
JAR_LEX="$(mktemp)"

for entry in "$WAYLAND_ID:$WAYLAND_HOST:$JAR_WAYLAND:wayland" "$CONCORD_ID:$CONCORD_HOST:$JAR_CONCORD:concord" "$LEX_ID:$LEX_HOST:$JAR_LEX:lex"; do
    IFS=":" read -r SID HOST JAR NAME <<< "$entry"
    MINT_RESP="$(http_body $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{\"site_id\":\"$SID\"}")"
    REDIRECT="$(echo "$MINT_RESP" | grep -oE 'http://[^"]+sso-redeem[^"]*' | head -1)"
    REDEEM_STATUS="$(curl -sS -o /dev/null -c "$JAR" --resolve "$HOST:80:127.0.0.1" -w "%{http_code}" "$REDIRECT")"
    assert_eq "303" "$REDEEM_STATUS" "$NAME: redeem returns 303"
    # cookie set?
    if grep -qE "$HOST.*ghost-admin-api-session" "$JAR" 2>/dev/null; then
        green "  PASS: $NAME: session cookie set on $HOST"
        PASS=$((PASS+1))
    else
        red "  FAIL: $NAME: no session cookie in jar"
        FAIL=$((FAIL+1))
    fi
done

# --- 5. Verify all 4 sites recognise the same superadmin -----------------
say ""
say "STEP 5: superadmin permission bypass (Phase 5d.1)"
for entry in "$DEFAULT_HOST:$JAR_DEFAULT:default" "$WAYLAND_HOST:$JAR_WAYLAND:wayland" "$CONCORD_HOST:$JAR_CONCORD:concord" "$LEX_HOST:$JAR_LEX:lex"; do
    IFS=":" read -r HOST JAR NAME <<< "$entry"
    S="$(http_status $HOST GET /ghost/api/admin/users/me/ $JAR)"
    assert_eq "200" "$S" "$NAME: /users/me/ returns 200 with superadmin session"
    S="$(http_status $HOST GET /ghost/api/admin/settings/ $JAR)"
    assert_eq "200" "$S" "$NAME: /settings/ returns 200 with superadmin session"
    S="$(http_status $HOST GET /ghost/api/admin/posts/ $JAR)"
    assert_eq "200" "$S" "$NAME: /posts/ returns 200 with superadmin session"
done

# --- 6. RLS tenant isolation: each site sees only its own data -----------
say ""
say "STEP 6: RLS tenant isolation (Phase 2/3)"
WAYLAND_POSTS="$(http_body $WAYLAND_HOST GET /ghost/api/admin/posts/ $JAR_WAYLAND)"
DEFAULT_POSTS="$(http_body $DEFAULT_HOST GET /ghost/api/admin/posts/ $JAR_DEFAULT)"
assert_contains "Wayland-only secret" "$WAYLAND_POSTS" "wayland /posts/ shows wayland-only post"
assert_not_contains "Wayland-only secret" "$DEFAULT_POSTS" "default /posts/ does NOT show wayland post"

# --- 7. SSO replay defence ------------------------------------------------
say ""
say "STEP 7: SSO replay defence"
MINT_RESP="$(http_body $DEFAULT_HOST POST /ghost/api/admin/session/sso-token $JAR_DEFAULT "{\"site_id\":\"$WAYLAND_ID\"}")"
REDIRECT="$(echo "$MINT_RESP" | grep -oE 'http://[^"]+sso-redeem[^"]*' | head -1)"
JAR_TMP="$(mktemp)"
FIRST_STATUS="$(curl -sS -o /dev/null -c "$JAR_TMP" --resolve "$WAYLAND_HOST:80:127.0.0.1" -w "%{http_code}" "$REDIRECT")"
SECOND_STATUS="$(curl -sS -o /dev/null --resolve "$WAYLAND_HOST:80:127.0.0.1" -w "%{http_code}" "$REDIRECT")"
assert_eq "303" "$FIRST_STATUS" "first redeem of token: 303"
assert_eq "401" "$SECOND_STATUS" "second redeem of same token: 401 (replay blocked)"
rm -f "$JAR_TMP"

# --- 8. SSO bad-token defence --------------------------------------------
say ""
say "STEP 8: SSO bad-token defence"
BAD_TOKEN_STATUS="$(curl -sS -o /dev/null --resolve "$WAYLAND_HOST:80:127.0.0.1" -w "%{http_code}" "http://$WAYLAND_HOST/ghost/api/admin/session/sso-redeem?token=not-a-real-token")"
assert_eq "401" "$BAD_TOKEN_STATUS" "garbage token: 401"
MISSING_TOKEN_STATUS="$(curl -sS -o /dev/null --resolve "$WAYLAND_HOST:80:127.0.0.1" -w "%{http_code}" "http://$WAYLAND_HOST/ghost/api/admin/session/sso-redeem")"
assert_eq "400" "$MISSING_TOKEN_STATUS" "missing token query param: 400"

# --- 9. Sign-out propagation (Phase 5d.2) --------------------------------
say ""
say "STEP 9: sign-out propagation"
# Confirm all 4 are still live
for entry in "$DEFAULT_HOST:$JAR_DEFAULT:default" "$WAYLAND_HOST:$JAR_WAYLAND:wayland" "$CONCORD_HOST:$JAR_CONCORD:concord" "$LEX_HOST:$JAR_LEX:lex"; do
    IFS=":" read -r HOST JAR NAME <<< "$entry"
    S="$(http_status $HOST GET /ghost/api/admin/users/me/ $JAR)"
    assert_eq "200" "$S" "before signout: $NAME /users/me/ = 200"
done

# Signout on DEFAULT — should fan out
SIGNOUT_STATUS="$(http_status $DEFAULT_HOST DELETE /ghost/api/admin/session/ $JAR_DEFAULT)"
assert_eq "204" "$SIGNOUT_STATUS" "signout on default returns 204"

# All sites should now reject the old cookies
for entry in "$DEFAULT_HOST:$JAR_DEFAULT:default" "$WAYLAND_HOST:$JAR_WAYLAND:wayland" "$CONCORD_HOST:$JAR_CONCORD:concord" "$LEX_HOST:$JAR_LEX:lex"; do
    IFS=":" read -r HOST JAR NAME <<< "$entry"
    S="$(http_status $HOST GET /ghost/api/admin/users/me/ $JAR)"
    assert_eq "403" "$S" "after signout: $NAME /users/me/ = 403"
done

# --- 10. Frontend render isolation ---------------------------------------
say ""
say "STEP 10: frontend render isolation"
for h in "$DEFAULT_HOST" "$WAYLAND_HOST" "$CONCORD_HOST" "$LEX_HOST"; do
    BODY="$(curl -sS --resolve "$h:80:127.0.0.1" "http://$h/")"
    if [[ "$h" == "$WAYLAND_HOST" ]]; then
        assert_contains "Wayland-only secret" "$BODY" "$h homepage shows wayland post"
    else
        assert_not_contains "Wayland-only secret" "$BODY" "$h homepage does NOT show wayland post"
    fi
done

# --- cleanup --------------------------------------------------------------
rm -f "$JAR_DEFAULT" "$JAR_WAYLAND" "$JAR_CONCORD" "$JAR_LEX"

# --- report ---------------------------------------------------------------
say ""
say "==================================================="
TOTAL=$((PASS+FAIL))
if [[ "$FAIL" -gt 0 ]]; then
    red " FAILED: $FAIL of $TOTAL assertions"
    say "==================================================="
    exit 1
else
    green " PASSED: $PASS of $TOTAL assertions"
    say "==================================================="
    exit 0
fi
