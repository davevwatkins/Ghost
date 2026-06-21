#!/usr/bin/env bash
# Add a town to the fleet: generates a DB password, registers the town, creates its
# database + user in the shared MySQL, regenerates compose+Caddy, and brings it up.
#
# Usage:  ./add-town.sh <slug> "<Display Name>" [subdomain]
# Example:./add-town.sh sudbury "Sudbury eNews" sudbury
#
# Prereqs: run from this folder on the server; .env filled in (copy from .env.example);
#          Docker installed; DNS for the subdomain pointed at this host (can be done after).
set -euo pipefail
cd "$(dirname "$0")"

SLUG="${1:?usage: add-town.sh <slug> \"<Display Name>\" [subdomain]}"
NAME="${2:?display name required}"
SUB="${3:-$SLUG}"

[ -f .env ] || { echo "ERROR: .env missing -- copy .env.example to .env and fill secrets."; exit 1; }

# 1) per-town DB password (idempotent)
if ! grep -q "^DBPASS_${SLUG}=" .env; then
  echo "DBPASS_${SLUG}=$(openssl rand -hex 16)" >> .env
  echo "added DBPASS_${SLUG} to .env"
fi

# 2) register the town in towns.json (idempotent)
python3 - "$SLUG" "$NAME" "$SUB" <<'PY'
import json, sys, pathlib
slug, name, sub = sys.argv[1:4]
p = pathlib.Path("towns.json"); cfg = json.loads(p.read_text())
if not any(t["slug"] == slug for t in cfg["towns"]):
    cfg["towns"].append({"slug": slug, "name": name, "subdomain": sub,
                         "dbName": f"ghost_{slug}", "dbUser": f"ghost_{slug}"})
    p.write_text(json.dumps(cfg, indent=2) + "\n")
    print(f"registered {slug} in towns.json")
else:
    print(f"{slug} already in towns.json")
PY

# 3) regenerate compose + Caddyfile so the new service exists
python3 generate.py

# 4) make sure shared MySQL is up, then create the town's DB + user
set -a; . ./.env; set +a
docker compose -f compose.fleet.yaml up -d mysql
echo "waiting for MySQL..."
for i in $(seq 1 30); do
  if docker compose -f compose.fleet.yaml exec -T mysql \
       mysqladmin ping -uroot -p"$MYSQL_ROOT_PASSWORD" >/dev/null 2>&1; then break; fi
  sleep 2
done
PW="$(grep "^DBPASS_${SLUG}=" .env | cut -d= -f2-)"
docker compose -f compose.fleet.yaml exec -T mysql \
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS ghost_${SLUG} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'ghost_${SLUG}'@'%' IDENTIFIED BY '${PW}';
GRANT ALL PRIVILEGES ON ghost_${SLUG}.* TO 'ghost_${SLUG}'@'%';
FLUSH PRIVILEGES;
SQL

# 5) bring up the whole fleet (new town's Ghost will boot + run migrations)
docker compose -f compose.fleet.yaml up -d

DOMAIN="$(python3 -c "import json;print(json.load(open('towns.json'))['domainBase'])")"
echo
echo "==> ${SLUG} is running."
echo "    1) Add a DNS A record at GoDaddy:  ${SUB}  ->  <this server's public IP>"
echo "    2) Once it resolves, Caddy auto-issues TLS; visit:"
echo "       https://${SUB}.${DOMAIN}/ghost   (create the owner account)"
echo "    3) Point the article publisher at it for that town."
