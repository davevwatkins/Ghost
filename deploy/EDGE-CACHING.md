# Edge caching + concurrency limiting (gateway hardening)

Stability "Now tier" for the multitenant stack. **Resource limits + heap caps are already
applied** (compose files, see `.env.example`). This doc covers the two gateway changes that
absorb load *before* it reaches the single Ghost process — the actual fix for the observed
crash (Ghost's one event loop saturating under concurrent **uncached** reads; it was never
memory — idle is ~370 MiB on a 31 GiB box).

> ⚠️ **This is security-sensitive in a multitenant install.** The cache key MUST be
> host-scoped (or one town's page is served for another — the same class of bug as the
> sitemap leak), and logged-in members MUST bypass the cache (or member-gated content leaks
> to anonymous readers). **Do not enable in production until the staging tests below pass.**
> Apply it on a staging copy first, run the tests, then promote.

---

## Why caching (not just bigger boxes)

A news front-end is read-heavy and changes rarely. Today every reader request renders in
Ghost's single Node event loop; a spike saturates it → health-check timeouts → crash →
slow cold boot (URLService rebuilds all 366 sites) → extended downtime. A short edge cache
turns a reader spike into a cache-hit spike and collapses Ghost's request volume 10–100×.
A request rate cap sheds the residual flood as `503` at the edge instead of letting it
collapse the loop.

---

## 1. Edge caching with Souin (`caddy cache-handler`)

Caddy has no built-in response cache; add the Souin module. Both Caddy images already
support plugins.

### 1a. Add the plugin

**Production** — `deploy/Dockerfile.caddy` (uses `xcaddy`):
```dockerfile
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/caddyserver/cache-handler          # Souin cache-handler
```
> Confirm the current module path/version at build time — Souin's packaging has moved
> (`github.com/caddyserver/cache-handler` is the maintained Caddy wrapper; older docs use
> `github.com/darkweak/souin/plugins/caddy`). The build failing fast is the signal to fix it.

(The dev gateway uses `caddy add-package <module>` if you ever want it locally — but caching
in dev is counterproductive: developers want fresh content. Leave dev uncached.)

### 1b. Configure (production `deploy/Caddyfile`)

Global block — cache defaults:
```caddyfile
{
    email {$ACME_EMAIL}

    # Souin defaults. Keys are method+HOST+path, so each *.townbrief.com tenant is
    # isolated — VERIFY on staging (Test A) before trusting it.
    cache {
        ttl 60s          # micro-cache window = max staleness without explicit purge
        stale 600s       # serve stale while revalidating in the background
    }
}
```

In the `*.townbrief.com` block, replace the single `reverse_proxy ghost:2368` with three
ordered handlers (first match wins):
```caddyfile
*.townbrief.com {
    import tbtls

    @admin_no_session {
        path /ghost /ghost/
        not header Cookie *ghost-admin-api-session=*
        not query sso=1
    }
    redir @admin_no_session https://superadmin.townbrief.com/sso/{http.request.host.labels.2}?next=%2Fghost%2F%3Fsso%3D1

    # (1) NEVER cache: admin, member APIs, link-tracking redirects, webmentions.
    @never_cache path /ghost* /members* /r/* /webmentions*
    handle @never_cache {
        reverse_proxy ghost:2368
    }

    # (2) Cacheable: ANONYMOUS (no member cookie) GET/HEAD only.
    @cacheable {
        method GET HEAD
        not header Cookie *ghost-members-ssr*
    }
    handle @cacheable {
        cache
        reverse_proxy ghost:2368
    }

    # (3) Everything else (POST, logged-in members, etc.) — straight through, no cache.
    handle {
        reverse_proxy ghost:2368
    }

    encode gzip
}
```

### 1c. The Cache-Control gotcha (validate on staging)

Ghost sends `Cache-Control: public, max-age=0` on rendered HTML (it's member-aware). Depending
on Souin's version this either (a) serves stale-while-revalidate within the `stale` window
(works as a micro-cache — ideal), or (b) revalidates on every request (cache is a no-op).
**Test B tells you which.** If it's (b), force the micro-cache by overriding Cache-Control —
but ONLY on `200`s, never on redirects/errors/member responses:
```caddyfile
    handle @cacheable {
        cache
        reverse_proxy ghost:2368 {
            @ok status 200
            header_down @ok Cache-Control "public, max-age=60, stale-while-revalidate=600"
        }
    }
```
Endpoints Ghost *already* marks cacheable (sitemaps, RSS, `/assets/*`, `/content/*`) cache
with no override and are zero-risk (no member/HTML personalization) — they're the safe floor
even if you defer HTML caching.

---

## 2. Concurrency / rate limiting (shed floods, don't collapse)

Add a rate limiter so a burst is bounded instead of saturating the event loop.

`deploy/Dockerfile.caddy`:
```dockerfile
    --with github.com/mholt/caddy-ratelimit
```
In the `*.townbrief.com` block (before the cache handlers), cap per-client request rate:
```caddyfile
    rate_limit {
        zone per_ip {
            key    {remote_host}
            events 120
            window 1m
        }
    }
```
Tune `events`/`window` from the load test (Test D). Cached hits are cheap, so this mainly
caps *uncached* pressure (members, writes, cache-miss storms). A global zone (`key static`)
additionally caps total in-flight if a single source isn't the problem.

---

## 3. Purge-on-publish (optional — short TTL is the baseline)

With `ttl 60s`, published content appears within 60 s with **zero** purge wiring — usually
fine for news. For instant updates, add explicit purge:

- **Souin API:** Souin exposes a purge endpoint (`PURGE` method / configurable API key). Wire
  a Ghost **webhook** (`post.published`, `post.unpublished`, `post.edited`, `site.changed`) →
  a tiny handler that issues the purge for that tenant's host keys.
- **Ghost's `X-Cache-Invalidate`:** Ghost already emits this header on content-mutating API
  responses listing the URL patterns to purge. A small sidecar can translate it into Souin
  purges. More work; do it only if 60 s staleness is unacceptable.

Keep purges **host-scoped** — purging by path alone would purge every tenant.

---

## Staging test checklist (MUST pass before production)

Run against a staging copy that mirrors prod (≥2 tenants with content + ≥1 test member).

- [ ] **A. Cross-tenant isolation.** `GET townA/` then `GET townB/` — responses differ;
      townA content NEVER appears for townB. Hammer concurrently. Inspect the `Cache-Status`
      header. **This is the non-negotiable one.**
- [ ] **B. HTML actually caches.** Two quick `GET townA/post/x/` → 2nd is a cache HIT
      (`Cache-Status: ... hit`) and faster. If not, apply the 1c override and re-test.
- [ ] **C. Member bypass.** Request with a member cookie → `Cache-Status` miss/bypass, gets
      personalized content; never served a cached anonymous page (and a member page is never
      cached for anonymous).
- [ ] **D. Admin/API never cached.** `/ghost`, `/ghost/api/*`, `/members/api/*`, `/r/*` →
      bypass; SSO + admin still work end-to-end (`python deploy/smoke-test.py`).
- [ ] **E. No bad cache.** Redirects (301/302), `404`s, and `5xx` are NOT cached as `200`s.
- [ ] **F. Purge (if wired).** Publish a post → it appears within the TTL (or instantly if
      purge is wired); unpublish → it's gone within the TTL.
- [ ] **G. Load test (prove the gain).** `k6`/`vegeta` a realistic read mix at rising
      concurrency, cache on vs off. Confirm: hit ratio high, p95 flat, **Ghost event-loop lag
      and CPU stay low**, no 502s. Record requests/sec-per-instance — that's your real
      capacity number for planning replicas/sharding (the "Next/Later" tiers).

Only after A–G pass: deploy to production (`docker compose -f deploy/compose.production.yaml
up -d --build caddy`), watch `Cache-Status` ratios + Ghost CPU, keep the limits as the backstop.
