# TownBrief multitenancy — one database, row-level isolation, US scale

Goal: operate every town (and the county) from **one Ghost process backed by one Postgres
database**, where adding a town is an INSERT into `sites`, not a container deploy. Targets
US scale (thousands of town publications) on commodity hardware.

This **supersedes [FLEET.md](FLEET.md)** for the real product. The fleet design (N
containers + N databases) is kept as the option for very small deployments (a handful of
towns) where the multitenancy port isn't worth the cost.

## Why row-level multitenancy

The fleet approach (one Ghost container per town) hits a hard wall around dozens of towns:
each Ghost container idles at ~300 MB, scheduled tasks run N times, container orchestration
overhead grows linearly, and cross-town features (one-account login, county-level
roll-ups) require a separate identity layer. At hundreds of towns it's infeasible on
commodity hosts; at thousands it's infeasible anywhere.

Row-level multitenancy means **one Node process, one Postgres database, every domain table
keyed by `site_id`**. Memory is shared. Scheduled jobs run once and fan out internally.
Cross-town features fall out for free. Scaling is bounded by Postgres throughput, which on
modern hardware comfortably handles thousands of low-to-medium-write tenants.

## Engine: Postgres-only

Ghost ships as MySQL-only in production (SQLite is dev-only). We switch the fork to
Postgres because of three load-bearing features:

1. **Row-Level Security (RLS)** — Postgres can enforce `site_id = current_setting('app.site_id')`
   on every query at the database layer. The application-layer wrapper (Phase 3) is the
   primary defense; RLS is the backstop against any code path that ever bypasses it. Any
   query that forgets `WHERE site_id = ?` returns zero rows instead of leaking cross-tenant
   data.
2. **Table partitioning by `site_id`** — declarative range/hash partitioning lets the
   highest-write tables (`members_*_events`, `email_recipients`, `mentions`) scale beyond
   what a single table on MySQL can handle.
3. **`jsonb`, MVCC, logical replication** — better per-site config storage, better
   concurrency under multi-tenant write load, easier per-tenant export and DR.

MySQL is removed from the fork entirely (see [TOWNBRIEF-CHANGES.md](../TOWNBRIEF-CHANGES.md)
for the Phase 0 engine port). Local unit tests can still use SQLite for paths that don't
exercise multitenancy.

## Architecture sketch

```
                  ┌─────────────────── one Ubuntu host ──────────────────┐
*.townbrief.com → │  Caddy (auto-TLS, wildcard or per-subdomain certs)    │
                  │      ALL subdomains  → ghost:2368                     │
                  │                                                       │
                  │  ghost  (ONE Node process, the fork)                  │
                  │     - host-resolver middleware reads Host:            │
                  │     - looks up sites.{slug,host,custom_domain}        │
                  │     - SET LOCAL app.site_id = '<id>' on the txn       │
                  │     - AsyncLocalStorage carries site_id app-side      │
                  │     - Bookshelf base model auto-scopes every query    │
                  │                                                       │
                  │  postgres:17  (ONE database, RLS-enforced)            │
                  │     sites                                             │
                  │     posts        (PK: id, FK: site_id, RLS policy)    │
                  │     members      (PK: id, FK: site_id, RLS policy)    │
                  │     … 78 more tables, all site_id-scoped …            │
                  └───────────────────────────────────────────────────────┘
```

Per-request flow:

1. Request hits Caddy → forwarded to Ghost with original `Host:` header.
2. **host-resolver middleware** (`web/parent/middleware/site-resolver.js`, Phase 1) is the
   first thing in the request pipeline. It resolves `Host:` → `sites.id` (subdomain match
   against `sites.host`, fallback to `sites.custom_domain` exact match). Returns 404 on no
   match.
3. Middleware acquires a connection from the pool, runs
   `SET LOCAL app.site_id = '<site_id>'`, and stores `site_id` on an AsyncLocalStorage
   context that all downstream code reads.
4. Every Bookshelf model query goes through a base override (Phase 3) that adds
   `WHERE site_id = ?` to reads and stamps `site_id` on writes.
5. Postgres RLS policy `USING (site_id = current_setting('app.site_id', true)::varchar)`
   on every site-scoped table is the backstop.

## Phasing

See the top-level task list. Summary:

- **Phase 0** *(in progress)*: MySQL → Postgres engine port. ~1–2 weeks.
- **Phase 1**: `sites` table, host resolver, AsyncLocalStorage context, RLS scaffolding.
- **Phase 2**: `site_id` column + composite unique constraints + RLS policy on every
  domain table. ~80 tables, mega-migration. Partition the highest-write tables.
- **Phase 3**: Bookshelf base model override — auto-inject `WHERE site_id`, auto-stamp on
  insert. Cross-site isolation test suite.
- **Phase 4**: De-singleton bootstrap — settings, theme, url-utils, members-service,
  stripe-service, mail-service become per-site caches. The hardest phase.
- **Phase 5**: Admin — superadmin vs per-site users, site picker, scoped admin API.
- **Phase 6**: Frontend — theme + asset isolation per site.
- **Phase 7**: Members + Stripe — single Stripe account, site metadata on every object,
  webhook dispatch by metadata.
- **Phase 8**: Email — per-site Mailgun sender on shared Mailgun infra.
- **Phase 9**: `add-site` flow (CLI + admin UI). Replaces the FLEET `add-town.sh` path.
- **Phase 10**: Retrofit the test suite for tenant scoping.

## What about upstream merges?

This permanently forks Ghost's data layer. Every upstream Ghost release will ship MySQL
migrations and assume single-tenant. Merging upstream from now on means re-porting
migrations to Postgres and adding `site_id`/RLS to any new tables, in the same pass.
That's the ongoing cost; the upside is one Node process serving a country's worth of
local-news subscriptions.

## What we lose

- Ghost's MySQL-based production reference. Any operational tooling that assumed MySQL
  binlog (Tinybird CDC integration in particular) is deferred — port to Postgres logical
  decoding or drop.
- Drop-in compatibility with Ghost's hosted upgrades. Forever.
- The ability to claim "vanilla Ghost" to customers. (Not a goal; TownBrief operates the
  fork itself.)
