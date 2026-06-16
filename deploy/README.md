# Deploying the TownBrief Ghost fork

This deploys the **forked** Ghost (your modified core) — which means self-hosting on a
server you control. Ghost(Pro) and GoDaddy shared/cPanel hosting cannot run a fork.

Two ways to get the image, then one way to run it.

---

## A. Get the image

**Option 1 — let CI build it (recommended).**
Pushing to the `townbrief` branch triggers `.github/workflows/townbrief-image.yml`, which
builds and publishes `ghcr.io/davevwatkins/ghost:latest` to GitHub Container Registry.
After the first run, make the package pullable (GitHub → Packages → `ghost` → settings →
Public, or issue a read:packages token for the server). The server then just pulls it.

**Option 2 — build on a Linux build host.**
```bash
IMAGE=townbrief-ghost:local deploy/build-image.sh
```
Requires Node 22 + pnpm + Docker. (Don't build on a tiny VPS — the admin build is heavy.)

---

## B. The server (DigitalOcean droplet)

Create a **plain Ubuntu droplet** — NOT the 1-click "Ghost" Marketplace image (that
installs stock Ghost, not this fork). amd64, so the CI image works unchanged.

Droplet spec:
- **Image:** Marketplace → **"Docker on Ubuntu 24.04"** (Docker preinstalled — skips step 4),
  or plain **Ubuntu 24.04 LTS**.
- **Plan:** Basic → Regular. **Minimum 2 GB / 1 vCPU / 50 GB ($12/mo).** Avoid the $6/1 GB
  tier (too little for MySQL 8). 4 GB is comfortable.
- **Region:** New York (closest to Massachusetts readers).
- **Auth:** add your SSH key.

1. **Create the droplet** and note its **public IPv4**. (Optional: assign a Reserved IP so
   the address survives a rebuild — set DNS to the Reserved IP if so.)
2. **Point DNS** (GoDaddy → Domains → townbrief.com → DNS):
   - Add an **A record**: host `wayland` → value `<droplet IP>` → TTL 600.
   - This makes `wayland.townbrief.com` resolve to the server (required before Caddy can
     get an HTTPS cert). Leave the existing `@`/`www` records alone.
3. **Open the firewall** for ports 22, 80, 443 (DO Cloud Firewall, or `ufw` on the box).
4. **SSH in and install Docker** (skip if you used the Docker Marketplace image):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
5. **Copy this `deploy/` folder to the server** (e.g. `scp -r deploy/ user@<ip>:~/townbrief/`).
6. **Configure secrets:**
   ```bash
   cd ~/townbrief
   cp .env.example .env
   nano .env          # set GHOST_IMAGE, passwords, SMTP, confirm the domain/url
   ```
   If pulling a private GHCR image: `echo <TOKEN> | docker login ghcr.io -u <you> --password-stdin`
7. **Launch:**
   ```bash
   docker compose -f compose.production.yaml up -d
   docker compose -f compose.production.yaml logs -f ghost
   ```
   Caddy fetches a Let's Encrypt cert automatically once DNS resolves.
8. **Finish setup** at `https://wayland.townbrief.com/ghost` — create the owner account.
9. **Create the Admin API key** (Settings → Integrations → custom) and drop it into
   `C:\Users\DaveWatkins\.ghost-admin-api-key.txt` so `Publish-WaylandToGhost.ps1` can push
   your pipeline's articles in as drafts.

---

## Updating (new Ghost release or your own changes)

1. Merge upstream into `townbrief` per the root `TOWNBRIEF-CHANGES.md` workflow, push.
2. CI rebuilds and republishes the image.
3. On the server:
   ```bash
   docker compose -f compose.production.yaml pull
   docker compose -f compose.production.yaml up -d   # runs DB migrations on boot
   ```
Back up `content` + the MySQL volume before major upgrades.

---

## Notes
- **Mail:** transactional email (member magic-link login) uses the SMTP in `.env`.
  **Newsletters** (bulk) require a Mailgun account configured in Ghost Admin — Ghost only
  does bulk email via Mailgun.
- **Backups:** persist the `ghost-content` and `mysql-data` Docker volumes.
- **GoDaddy alternative:** if a GoDaddy VPS feels heavy/pricey, keep the domain at GoDaddy
  and run this exact stack on a DigitalOcean droplet — only step B.1 changes.
