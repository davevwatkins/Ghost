# Go-live cutover: fleet → multitenant

Flip `*.townbrief.com` from the old per-town fleet to the multitenant (Postgres + RLS)
stack. The data is already migrated (366 sites / 6,707 posts); this doc is only the
**routing flip**. The fleet stays running the whole time as an instant rollback.

## Current state (verified 2026-06-30)

| Thing | State |
|---|---|
| DNS / nameservers | ✅ Cloudflare (`margo`/`summer.ns.cloudflare.com`), zone **active** |
| `*.townbrief.com` → box | ✅ resolves to `51.81.86.103` |
| Cloudflare API token (in `deploy/.env`) | ✅ valid + active → wildcard cert can issue via DNS-01 |
| Data migrated | ✅ 366 sites, 6,707 posts, readiness-verified (home/RSS/sitemap/portal/RLS) |
| Multitenant image + caddy image | ✅ `ghcr.io/davevwatkins/ghost:latest` + `townbrief-caddy:local` built |
| Wildcard TLS cert | ⬜ not yet issued (issues on first caddy boot via DNS-01) |
| Public `:80/:443` on `51.81.86.103` | ⛴ held by the **fleet** caddy `townbrief-caddy-1` (project `townbrief`, `/root/townbrief`) |

**Nothing is left for Dave to do in Cloudflare.** The only remaining step is the server-side flip.

## ⚠️ The one gotcha: bind the specific IP

The box has two public IPs. `townbrief-caddy-1` binds **`51.81.86.103`** specifically; `tezox-caddy-1`
binds `51.81.21.27`. The multitenant `compose.production.yaml` maps `"80:80"`/`"443:443"` = `0.0.0.0`,
which would collide with tezox. So the multitenant caddy MUST bind `51.81.86.103` only. Use this override:

`/root/townbrief-mt/deploy/compose.cutover.yaml`
```yaml
services:
  caddy:
    ports:
      - "51.81.86.103:80:80"
      - "51.81.86.103:443:443"
```
(compose replaces the whole `ports` list from an override file, so this fully substitutes the `0.0.0.0` mapping.)

## Step 0 — pre-stage the wildcard cert (recommended, zero public impact)

Prove cert issuance + TLS serving BEFORE touching the live port, on an alternate port:
```bash
cd /root/townbrief-mt/deploy
docker compose -f compose.production.yaml build superadmin           # ~2 min, once
# temp caddy on 8443 (a throwaway override; does NOT touch :443)
printf 'services:\n  caddy:\n    ports:\n      - "51.81.86.103:8080:80"\n      - "51.81.86.103:8443:443"\n' > compose.pretest.yaml
docker compose -p tb-pretest -f compose.production.yaml -f compose.staging.yaml -f compose.pretest.yaml up -d caddy superadmin
# caddy obtains *.townbrief.com via DNS-01; then:
curl -s -o /dev/null -w '%{http_code}\n' --resolve wayland.townbrief.com:8443:51.81.86.103 https://wayland.townbrief.com:8443/
# expect 200 over a valid cert, showing the MULTITENANT wayland (259 posts)
docker compose -p tb-pretest -f compose.production.yaml -f compose.staging.yaml -f compose.pretest.yaml down
```
The issued cert persists in the `caddy-data` volume, so the real flip below is instant (no cold ACME).

## Step 1 — the flip

```bash
cd /root/townbrief-mt/deploy
# 1. free the port: stop the fleet caddy (fleet Ghosts keep running, just unrouted)
docker stop townbrief-caddy-1
# 2. bring up the multitenant edge on the box IP
docker compose -f compose.production.yaml -f compose.cutover.yaml up -d ghost superadmin caddy
# 3. watch it come healthy + grab the cert (if not pre-staged)
docker logs -f townbrief-prod-caddy-1   # Ctrl-C once serving
```

## Step 2 — verify live (real DNS, real TLS)

```bash
for s in wayland natick middlesexcounty saugus; do
  echo -n "$s: "; curl -s -o /dev/null -w '%{http_code}\n' https://$s.townbrief.com/
done
# wayland should now show 259 posts (the fleet showed far fewer)
curl -s https://superadmin.townbrief.com/ -o /dev/null -w 'superadmin: %{http_code}\n'
```
Also run the readiness suite against real domains:
`TB_SCHEME=https TB_BASE_DOMAIN=townbrief.com python3 deploy/smoke-test.py`

## Rollback (instant — the fleet never stopped serving content, just routing)

```bash
docker compose -f compose.production.yaml -f compose.cutover.yaml down   # stop multitenant caddy
docker start townbrief-caddy-1                                            # fleet caddy retakes :80/:443
```
Rollback window is seconds. Keep the fleet up until you're confident (days), then decommission.

## Post-cutover follow-ups (not blockers)

- **Owner/superadmin model:** every migrated site currently has an Owner *copied* from the original
  user (the workaround for the missing `is_superadmin` seed). Fine for serving; before real editors log
  in, seed a proper `is_superadmin` user and re-point owners / SSO mirror users.
- **Stripe:** wire the platform Stripe account per-site (`townbrief_site_id` metadata) before taking payments.
- **`staffDeviceVerification`** is off until SMTP is confirmed; flip to `true` once mail is verified.
- **Decommission the fleet** (`/root/townbrief`, ~365 idle Ghosts + MySQL) once the multitenant stack has
  proven itself — frees the box. Optionally `mv /root/townbrief-mt /root/townbrief` afterward (same project name).
