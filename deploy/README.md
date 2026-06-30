# Deploying the TownBrief Ghost fork (multitenant, Postgres)

This deploys the **forked** Ghost — the multitenant, Postgres + RLS core — self-hosted on a
server you control. Ghost(Pro) and shared/cPanel hosting cannot run a fork. **One** Node
process serves **every town and county** as `<slug>.townbrief.com`; adding a town is an
`INSERT` into the `sites` table, not a new container. See [MULTITENANCY.md](MULTITENANCY.md)
for the architecture.

> This supersedes the old single-tenant MySQL runbook. The whole MA set (~366 tenants) runs
> in one process on well under a gigabyte of RAM.

---

## A. Get the Ghost image

**Option 1 — let CI build it (recommended).** Pushing to the `townbrief` branch triggers
`.github/workflows/townbrief-image.yml`, which builds and publishes
`ghcr.io/davevwatkins/ghost:latest` to GHCR. The image bakes the pnpm patches
(`knex-migrator` + `bookshelf`) that are **required** to run on Postgres. After the first
run, make the package pullable (GitHub → Packages → `ghost` → Public, or a read:packages
token on the server).

**Option 2 — build on a Linux build host.**
```bash
IMAGE=townbrief-ghost:local deploy/build-image.sh   # Node 22 + pnpm + Docker; heavy, not on a tiny VPS
```

---

## B. The server

A **plain Ubuntu 24.04** box (DigitalOcean droplet, Hetzner, etc.) with Docker — NOT a
1-click "Ghost" image. amd64.

- **Plan:** **4 GB / 2 vCPU / 80 GB** is comfortable for the full fleet (Ghost ~0.6–1 GB at
  366 tenants + Postgres + Redis + headroom for content). 2 GB works for a smaller set.
- **Region:** New York (closest to MA readers).

1. **Create the box**, note its **public IPv4** (a Reserved/Floating IP is nice so the
   address survives a rebuild).
2. **Open the firewall** for ports **22, 80, 443**.
3. **Install Docker** (skip if the image ships it): `curl -fsSL https://get.docker.com | sh`
4. **Clone the repo on the server** (the stack references files across the tree — the
   `postgres-init` script, `Caddyfile`, `Dockerfile.caddy`):
   ```bash
   git clone <repo-url> townbrief && cd townbrief/deploy
   ```

### DNS + wildcard TLS (the important part)

Every town is a subdomain, so we terminate TLS with **one wildcard cert** (`*.townbrief.com`)
issued via the **DNS-01** ACME challenge. (HTTP-01 can't issue wildcards, and one-cert-per-
subdomain would exceed Let's Encrypt's ~50 certs/week/registered-domain at this scale.)
DNS-01 needs a DNS-provider plugin — the Caddy image here is built with the **Cloudflare**
plugin by default.

5. **Move townbrief.com's DNS to Cloudflare** (free), then:
   - Add a DNS record so the subdomains resolve to the server:
     `*  A  <server IP>` (wildcard) and `@  A  <server IP>` for the apex.
   - Create a scoped **API token**: *My Profile → API Tokens → Create → Edit zone DNS*,
     **Zone:DNS:Edit** for `townbrief.com`. (To use a different DNS provider instead, swap
     the plugin in [`Dockerfile.caddy`](Dockerfile.caddy) and the `dns` directive in
     [`Caddyfile`](Caddyfile).)

### Configure + launch

6. **Secrets:**
   ```bash
   cp .env.example .env
   nano .env   # Postgres super + ghost_app passwords, CLOUDFLARE_API_TOKEN, ACME_EMAIL, SMTP, GHOST_PUBLIC_URL
   ```
   Private GHCR image? `echo <TOKEN> | docker login ghcr.io -u <you> --password-stdin`
7. **Launch** (the Caddy image builds locally on first up):
   ```bash
   docker compose -f compose.production.yaml up -d --build
   docker compose -f compose.production.yaml logs -f ghost
   ```
   On fresh init Postgres runs `docker/postgres-init/01-ghost-app-role.sh` (creates the
   non-super `ghost_app` role) and Ghost runs migrations + seeds the `default` site.
8. **Verify RLS is enforced** (Ghost must be the non-super role):
   ```bash
   docker compose -f compose.production.yaml exec postgres \
     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='ghost_app';"
   # expect: ghost_app | f | f
   ```

### Provision the towns

9. Add each town as a tenant (site row + settings + roles + owner + Admin key):
   ```bash
   docker compose -f compose.production.yaml exec ghost \
     node scripts/townbrief-add-site.js --slug=wayland --name="The Wayland Post" \
       --host=wayland.townbrief.com --owner-email=editor@townbrief.com
   ```
   Bulk-migrate an existing fleet's content with `migrate_fleet_to_multitenancy.py`
   (Phase 2). Each tenant's content publishes from the pipeline via `publish_to_ghost.py`
   pointed at `https://<slug>.townbrief.com` with that tenant's Admin API key.

---

## Updating (new Ghost release or your own changes)

1. Merge upstream into `townbrief` per the root [`TOWNBRIEF-CHANGES.md`](../TOWNBRIEF-CHANGES.md)
   workflow (re-port any new migrations to Postgres + add `site_id`/RLS), push.
2. CI rebuilds the image.
3. On the server:
   ```bash
   docker compose -f compose.production.yaml pull
   docker compose -f compose.production.yaml up -d   # runs DB migrations on boot
   ```
Back up the `postgres-data` and `ghost-content` volumes before major upgrades.

---

## Notes
- **Apex landing page:** `townbrief.com` serves the static project page from
  `deploy/site/index.html` (the "every meeting, every town" directory that links to all
  the town pubs); `www` 301s to the apex. Edit that file to change the page. The town
  subdomains (`*.townbrief.com`) are the Ghost tenants, not this page.
- **Mail:** transactional email (member magic-link login) uses the SMTP in `.env`.
  **Newsletters** (bulk) require a Mailgun account configured per-site in Ghost Admin.
- **Backups:** persist the `postgres-data` and `ghost-content` Docker volumes. A
  `pg_dump`-to-object-storage cron is recommended.
- **Postgres tuning:** the `shared_buffers`/`effective_cache_size` flags in
  `compose.production.yaml` suit ~4–8 GB; raise them on bigger hosts.
- **RLS is load-bearing:** Ghost MUST connect as the non-super `ghost_app` role (step 8).
  If that role is missing, the app runs but without cross-tenant isolation.
