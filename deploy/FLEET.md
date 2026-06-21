# TownBrief fleet architecture (one system, many towns)

Goal: operate every town (and the county) from **one system** — one image, one reverse
proxy, one database server, one ops workflow — where adding a town is a config entry, not
an engineering project. Each town is still its own Ghost instance (Ghost is
one-publication-per-instance); we orchestrate the fleet rather than fork Ghost's data layer.

## Topology

```
                          ┌──────────────── one Ubuntu host ─────────────────┐
  *.townbrief.com  DNS →  │  Caddy (auto-TLS, routes by subdomain)            │
                          │     wayland.townbrief.com  → ghost-wayland:2368   │
                          │     sudbury.townbrief.com  → ghost-sudbury:2368   │
                          │     concord.townbrief.com  → ghost-concord:2368   │
                          │     news.townbrief.com     → ghost-county:2368    │
                          │                                                   │
                          │  ghost-<town>  (N containers, SAME forked image)  │
                          │     env: url, database=ghost_<town>, content vol  │
                          │                                                   │
                          │  mysql:8.4  (ONE server, N databases)             │
                          │     ghost_wayland, ghost_sudbury, ghost_concord…  │
                          └───────────────────────────────────────────────────┘
```

Key decisions:
- **One image** for all towns: `ghcr.io/davevwatkins/ghost:latest` (the fork). One build, one update.
- **One MySQL, N databases** (not N MySQL servers) — saves ~300–500 MB RAM per town.
- **One content volume per town** (`ghost-content-<town>`) for uploads/images isolation.
- **Caddy** terminates TLS for every subdomain and reverse-proxies to the right container.
- **Per-town env** is the only thing that differs between instances.

## DNS

Two options:
1. **Per-subdomain A records** (simplest): `wayland`, `sudbury`, … each → host IP. Caddy gets a
   Let's Encrypt cert per subdomain via HTTP-01. Fine up to dozens of towns.
2. **Wildcard** `*.townbrief.com` → host IP + a wildcard cert via DNS-01 (needs Caddy's GoDaddy
   DNS plugin + a GoDaddy API key). One DNS record, one cert. Worth it past ~10 towns.

## Per-town config (the only per-instance difference)

```
ghost-<town>:
  image: ghcr.io/davevwatkins/ghost:latest
  environment:
    url: https://<town>.townbrief.com
    database__client: mysql
    database__connection__host: mysql
    database__connection__database: ghost_<town>
    database__connection__user: ghost_<town>      # per-town DB user (isolation)
    database__connection__password: <generated>
    server__host: "0.0.0.0"
    security__staffDeviceVerification: "false"     # until email is live
    mail__transport: SMTP                           # shared relay (2525) or per-town sender
    mail__options__host: smtp.mailgun.org
    mail__options__port: "2525"
    mail__options__auth__user: <relay user>
    mail__options__auth__pass: <relay pass>
    mail__from: "<Town> News <newsletter@townbrief.com>"
  volumes:
    - ghost-content-<town>:/home/ghost/content
  depends_on: { mysql: { condition: service_healthy } }
```

## "Add a town" — the one-command goal

A `towns.json` (name, subdomain, data-root) drives a generator that renders
`compose.fleet.yaml` + Caddy blocks, then provisions:

```
add-town <slug>:
  1. create MySQL db ghost_<slug> + user/grant
  2. render compose service + Caddy site block from template
  3. docker compose up -d ghost-<slug>      # first boot runs migrations
  4. (DNS) add A record <slug>.townbrief.com  (manual, or GoDaddy API)
  5. POST owner via Admin API; activate theme; set tiers/nav (reuse the scripts we built)
  6. point the publisher:  Publish-WaylandToGhost.ps1 -Town <slug> -Url https://<slug>.townbrief.com
```

The Wayland pipeline is already town-parameterized (`E:\townbrief\<town>\`), so step 6 is just
flags. The theme/tiers/nav/publisher scripts from the Wayland build are the template.

## Migrating the current Wayland instance into the fleet

Low-friction: the existing `townbrief-mysql-1` already holds db `ghost`. Either rename it to
`ghost_wayland` or just add the new towns' databases alongside it, and fold the existing
`ghost` service into the fleet compose as the first town. No content migration needed.

## Resources & cost

- Each Ghost idles ~250–400 MB; shared MySQL ~0.5–1 GB; Caddy ~30 MB.
- 8 instances (7 towns + county) ≈ 3–5 GB working set → an **8–16 GB** host is comfortable.
- ~$48–96/mo on DigitalOcean for one 8–16 GB droplet, less on Hetzner — vs. 8× $12 separate droplets.

## Effort

| Piece | Effort |
|---|---|
| Templated compose + Caddy per-subdomain routing | 1–2 days |
| Shared-MySQL refactor (N databases, per-town users) | 1 day |
| `towns.json` + generator + `add-town` provisioning script | 2–4 days |
| Fold existing Wayland in; smoke-test 2nd town end-to-end | 1–2 days |
| **Total to a repeatable multi-town fleet** | **~1–2 weeks** |

**No core fork. Fully updatable** (one image bump updates all towns).
Does NOT provide cross-town login or bundled billing — see SHARED-IDENTITY.md.
