#!/usr/bin/env bash
###############################################################################
# migrate-fleet-to-prod.sh   (v2 — shared-MySQL direct export)
#
# Migrate live per-town FLEET content (the old single-tenant Ghosts, whose data
# all lives in the ONE shared `townbrief-mysql-1`) into the MULTITENANT (Postgres
# + RLS) prod stack, ONE TOWN AT A TIME. Proven on natick/weston/sudbury/lincoln/
# wellesley/marlborough/wayland 2026-06.
#
# v2 change: exports each town DIRECTLY from townbrief-mysql-1 via a single
# dedicated helper container (tb-migrator) on the fleet network — it does NOT
# start per-town Ghost containers. That makes `--all` safe on this sablier-gated,
# 22 GB box (starting hundreds of fleet Ghosts would OOM it).
#
# RUN ON THE SERVER. Read-only against the fleet DB; writes only into the
# non-public townbrief-prod stack via loopback :2369. Live fleet untouched.
#
# Usage:
#   ./migrate-fleet-to-prod.sh --dry-run                 # list what WOULD migrate
#   ./migrate-fleet-to-prod.sh concord                   # specific town slug(s)
#   ./migrate-fleet-to-prod.sh --all                     # every fleet town not yet done
#   ./migrate-fleet-to-prod.sh --all --skip wayland,natick
#
# Idempotent: a town that already has posts in prod is skipped (unless --force).
###############################################################################
set -uo pipefail

PG=townbrief-prod-postgres-1
G=townbrief-prod-ghost-1
MYSQLC=townbrief-mysql-1
HELPER=tb-migrator
FLEETNET=townbrief_default
ENDPOINT="http://127.0.0.1:2369"
XFP="X-Forwarded-Proto: https"
POLL_SECS=90

DRY=0; FORCE=0; ALL=0; SKIP=""; SLUGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --force)   FORCE=1 ;;
    --all)     ALL=1 ;;
    --skip)    SKIP=",$2,"; shift ;;
    --skip=*)  SKIP=",${1#*=}," ;;
    -*)        echo "unknown flag: $1" >&2; exit 2 ;;
    *)         SLUGS+=("$1") ;;
  esac
  shift
done

PGU=$(docker exec "$PG" printenv POSTGRES_USER </dev/null)
PGD=$(docker exec "$PG" printenv POSTGRES_DB </dev/null)
q(){ docker exec "$PG" psql -U "$PGU" -d "$PGD" -tAc "$1" </dev/null; }
MYSQLPW=$(docker exec "$MYSQLC" printenv MYSQL_ROOT_PASSWORD </dev/null)

# Preload already-migrated slugs (slug -> post count) in ONE query (O(1) skip checks).
declare -A MIGRATED
while IFS='|' read -r _sl _cnt; do [ -n "$_sl" ] && MIGRATED["$_sl"]="$_cnt"; done \
  < <(q "select s.slug||'|'||count(p.id) from sites s left join posts p on p.site_id=s.id group by s.slug")

# ---- exporter: dumps a town's MySQL (selected by the database__* env we pass) to JSON ----
EXPORTER=/tmp/tb-exporter.js
cat >"$EXPORTER" <<'JS'
const tryReq=(m)=>{try{return require(m);}catch(e){return null;}};
const mysql=tryReq("mysql2/promise")||tryReq("/var/lib/ghost/current/node_modules/mysql2/promise")||tryReq("/home/ghost/node_modules/mysql2/promise");
const TABLES=['newsletters','posts','posts_meta','posts_tags','posts_authors','tags','settings','custom_theme_settings','snippets','labels','webhooks','comments','comment_likes','comment_reports'];
const SK=['stripe_secret_key','stripe_publishable_key','stripe_connect_secret_key','stripe_connect_publishable_key','stripe_plans','stripe_connect_livemode','stripe_billing_portal_configuration_id','stripe_connect_display_name','stripe_connect_account_id'];
const DROP=['site_uuid'];
(async()=>{const _pw=process.env['database__connection__password'];const conn=await mysql.createConnection({host:process.env.database__connection__host||'mysql',user:process.env.database__connection__user,password:_pw,database:process.env.database__connection__database,dateStrings:true,timezone:'+00:00'});const data={};for(const t of TABLES){try{const [r]=await conn.execute('SELECT * FROM `'+t+'`');data[t]=r;}catch(e){data[t]=[];}}await conn.end();if(data.settings)data.settings=data.settings.filter(r=>!SK.includes(r.key)&&!DROP.includes(r.key));if(data.tags)data.tags=data.tags.filter(t=>t.name&&t.name.trim()&&t.slug&&t.slug.trim());if(data.posts)data.posts.forEach(p=>{p.title=(String(p.title||'').replace(new RegExp(String.fromCharCode(0),'g'),'').trim())||p.slug||'(untitled)';});process.stdout.write(JSON.stringify({db:[{meta:{exported_on:Date.now(),version:'5.95.0'},data}]}).replace(/\\u0000/g,''));})().catch(e=>{process.stderr.write(String(e));process.exit(1);});
JS

ensure_helper(){
  docker inspect "$HELPER" >/dev/null 2>&1 && return
  local img; img=$(docker inspect townbrief-ghost-1 --format '{{.Config.Image}}' </dev/null 2>/dev/null)
  docker run -d --name "$HELPER" --network "$FLEETNET" --entrypoint sleep "$img" infinity </dev/null >/dev/null
  sleep 2
}
cleanup(){ [ "$DRY" = "0" ] && docker rm -f "$HELPER" >/dev/null 2>&1 </dev/null || true; }
trap cleanup EXIT

# ---- work list ----
if [ "$ALL" = "1" ]; then
  mapfile -t SLUGS < <(docker exec "$MYSQLC" sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -e "show databases"' </dev/null 2>/dev/null \
    | grep -ivE '^(information_schema|performance_schema|mysql|sys|townbrief_mcp|waylandenews)$' \
    | sed 's/^ghost$/wayland/' | sort -u)
fi
[ ${#SLUGS[@]} -eq 0 ] && { echo "No towns specified. Use slugs, or --all."; exit 2; }

echo "================================================================="
echo "Fleet -> multitenant migration v2  (towns: ${#SLUGS[@]}; dry=$DRY force=$FORCE)"
echo "================================================================="
printf '%-22s %-8s %-8s %-6s %s\n' SLUG EXPORTED LANDED HTTP STATUS

migrate_one(){
  local slug="$1"
  case "$SKIP" in *",$slug,"*) printf '%-22s %-8s %-8s %-6s %s\n' "$slug" - - - "SKIP(--skip)"; return;; esac
  if [ "$FORCE" = "0" ] && [ -n "${MIGRATED[$slug]:-}" ] && [ "${MIGRATED[$slug]}" -gt 0 ]; then
    printf '%-22s %-8s %-8s %-6s %s\n' "$slug" - "${MIGRATED[$slug]}" - "SKIP(exists)"; return
  fi
  if [ "$DRY" = "1" ]; then printf '%-22s %-8s %-8s %-6s %s\n' "$slug" "?" "?" "?" "WOULD-MIGRATE"; return; fi

  local db="$slug"; [ "$slug" = "wayland" ] && db="ghost"   # flagship's legacy DB name

  ensure_helper
  local bk=/tmp/tb-$slug.json
  docker exec -i -e database__connection__host=mysql -e database__connection__user=root \
    -e database__connection__password="$MYSQLPW" -e database__connection__database="$db" \
    "$HELPER" node - <"$EXPORTER" >"$bk" 2>/dev/null
  if [ ! -s "$bk" ]; then printf '%-22s %-8s %-8s %-6s %s\n' "$slug" - - - "EXPORT-FAIL(db=$db)"; return; fi

  local expected title host
  expected=$(python3 -c "import json;d=json.load(open('$bk'));print(len([p for p in d['db'][0]['data']['posts'] if p.get('status')=='published' and p.get('type')=='post']))" 2>/dev/null)
  title=$(python3 -c "import json;d=json.load(open('$bk'));s={r['key']:r['value'] for r in d['db'][0]['data']['settings']};print((s.get('title') or '$slug').strip() or '$slug')" 2>/dev/null)
  [ -z "$title" ] && title="$slug"
  host="$slug.townbrief.com"

  # provision (idempotent)
  local sid; sid=$(q "select id from sites where slug='$slug'")
  if [ -z "$sid" ]; then
    docker exec "$G" node scripts/townbrief-add-site.js --slug="$slug" --name="$title" --host="$host" </dev/null >/dev/null 2>&1
    sid=$(q "select id from sites where slug='$slug'")
  fi
  [ -z "$sid" ] && { printf '%-22s %-8s %-8s %-6s %s\n' "$slug" "${expected:-?}" - - "PROVISION-FAIL"; rm -f "$bk"; return; }

  # ensure an Owner user (import 404s "Owner not found" without one)
  if [ "$(q "select count(*) from roles_users ru join roles r on r.id=ru.role_id where ru.site_id='$sid' and r.name='Owner'")" = "0" ]; then
    local orole nid rid now
    orole=$(q "select id from roles where site_id='$sid' and name='Owner' limit 1")
    nid=$(openssl rand -hex 12); rid=$(openssl rand -hex 12); now=$(date -u +'%Y-%m-%d %H:%M:%S')
    q "BEGIN; SET LOCAL app.site_id='$sid'; CREATE TEMP TABLE tmp_u AS SELECT * FROM users ORDER BY created_at LIMIT 1; UPDATE tmp_u SET id='$nid', site_id='$sid', slug='$slug-owner', email='owner-$slug@townbrief.com', created_at='$now', updated_at='$now'; INSERT INTO users SELECT * FROM tmp_u; INSERT INTO roles_users(id,site_id,role_id,user_id) VALUES('$rid','$sid','$orole','$nid'); COMMIT;" >/dev/null 2>&1
  fi

  # mint an Admin API key (add-site.js does NOT)
  local key arole iid aid sec now2
  key=$(q "select ak.id||':'||ak.secret from api_keys ak where ak.site_id='$sid' and ak.type='admin' limit 1")
  if [ -z "$key" ]; then
    arole=$(q "select id from roles where site_id='$sid' and name='Administrator' limit 1")
    iid=$(openssl rand -hex 12); aid=$(openssl rand -hex 12); sec=$(openssl rand -hex 32); now2=$(date -u +'%Y-%m-%d %H:%M:%S')
    q "insert into integrations(id,site_id,type,name,slug,created_at,updated_at) values('$iid','$sid','custom','$slug migration','$slug-migration-key','$now2','$now2')" >/dev/null
    q "insert into api_keys(id,site_id,type,secret,role_id,integration_id,created_at,updated_at) values('$aid','$sid','admin','$sec','$arole','$iid','$now2','$now2')" >/dev/null
    key="$aid:$sec"
  fi

  # import (async; XFP so Ghost serves https on the loopback)
  local jwt
  jwt=$(docker exec "$G" node -e "const j=require('jsonwebtoken');const[a,b]=process.argv[1].split(':');console.log(j.sign({},Buffer.from(b,'hex'),{keyid:a,algorithm:'HS256',expiresIn:'5m',audience:'/admin/'}))" "$key" </dev/null)
  curl -s -o /dev/null -X POST "$ENDPOINT/ghost/api/admin/db/" -H "Host: $host" -H "$XFP" \
       -H "Authorization: Ghost $jwt" -F "importfile=@$bk;type=application/json"

  # poll for async import to land
  local landed=0 t=0
  while [ "$t" -lt "$POLL_SECS" ]; do
    landed=$(q "select count(*) from posts where site_id='$sid' and status='published' and type='post'")
    [ "${landed:-0}" -ge "${expected:-0}" ] && break
    sleep 3; t=$((t+3))
  done

  local hp; hp=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" -H "$XFP" "$ENDPOINT/")
  local status="OK"; [ "$hp" = "200" ] || status="CHECK"; [ "${landed:-0}" -lt "${expected:-0}" ] && status="PARTIAL"
  printf '%-22s %-8s %-8s %-6s %s\n' "$slug" "${expected:-?}" "${landed:-0}" "$hp" "$status"
  rm -f "$bk"
}

for s in "${SLUGS[@]}"; do migrate_one "$s"; done
echo "================================================================="
echo "Done. Verify a sample with the readiness suite (smoke-test.py / content-link-check.py)."
