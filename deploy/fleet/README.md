# TownBrief fleet — one system, many towns

Run every town from one host: one forked-Ghost image, one Caddy (auto-HTTPS, routes by
subdomain), one shared MySQL (one database per town), N Ghost containers. Adding a town is
a single command. See `../FLEET.md` for the architecture rationale.

## Files
| File | Role |
|------|------|
| `towns.json` | Source of truth — the list of towns (slug, name, subdomain, db). |
| `generate.py` | Renders `compose.fleet.yaml` + `Caddyfile` from `towns.json`. No secrets. |
| `add-town.sh` | Provisions a new town end-to-end (db + user + config + boot). |
| `.env.example` | Template for shared secrets (image, MySQL root, SMTP) + per-town DB passwords. |
| `.env` | Your real secrets (gitignored). |
| `compose.fleet.yaml`, `Caddyfile` | Generated artifacts (gitignored). |

## Bootstrap (fresh host)
```bash
cp .env.example .env          # fill GHOST_IMAGE, MYSQL_ROOT_PASSWORD, SMTP_*
# (Wayland is already in towns.json; add DBPASS_wayland=<its db password> to .env)
python3 generate.py
docker compose -f compose.fleet.yaml up -d
```

## Add a town
```bash
./add-town.sh sudbury "Sudbury eNews" sudbury
```
This generates a DB password, registers the town, creates its database + user, regenerates
the config, and boots its Ghost. Then:
1. Add a GoDaddy **A record**: `sudbury` → the host's public IP.
2. Once it resolves, Caddy issues TLS automatically; open `https://sudbury.townbrief.com/ghost`
   to create the owner account.
3. Point your publishing pipeline at `https://sudbury.townbrief.com` for that town.

## Updating Ghost across all towns
```bash
docker compose -f compose.fleet.yaml pull   # new image from CI
docker compose -f compose.fleet.yaml up -d  # rolling recreate; each runs DB migrations
```

## Migrating the existing single-Wayland deploy into the fleet
The current live site runs from `/root/townbrief/compose.production.yaml` (project `townbrief`,
database `ghost`). To fold it in **without data loss**:
1. Copy this `fleet/` folder to the server.
2. In `.env`, set `DBPASS_wayland` to the **existing** Wayland DB password (from
   `/root/townbrief/.env` → `MYSQL_PASSWORD`). `towns.json` already maps wayland to
   `dbName: ghost`, `dbUser: ghost` so it reuses the current database.
3. **Stop the old stack** so it releases ports 80/443 and the MySQL volume:
   `docker compose -f /root/townbrief/compose.production.yaml down` (keeps volumes).
4. Point the fleet at the **same MySQL data volume** (either run the fleet from
   `/root/townbrief` so the `mysql-data` volume name matches, or `docker volume` rename /
   re-mount the existing volume). Verify the volume name with `docker volume ls` before
   switching — this is the one careful step; back up first:
   `docker run --rm -v <mysql_volume>:/v -v $PWD:/b busybox tar czf /b/mysql-backup.tgz -C /v .`
5. `python3 generate.py && docker compose -f compose.fleet.yaml up -d`, then confirm
   `https://wayland.townbrief.com` still serves before adding more towns.

> Do this migration deliberately, off-hours, with the backup in hand. Until then the fleet
> tooling can be developed/tested with a throwaway town on a separate host.

## Notes
- **Resources:** ~8 instances fit on an 8–16 GB host (each Ghost ~0.3 GB; shared MySQL ~0.5–1 GB).
- **Secrets** never enter `towns.json` or the generated files — only `.env`.
- **Per-town overrides** (custom theme, different mail from-name) can be added to `towns.json`
  and wired through `generate.py` as the fleet grows.
- This is the **fleet layer only**; cross-town single sign-on + bundled billing is a separate
  layer — see `../SHARED-IDENTITY.md`.
