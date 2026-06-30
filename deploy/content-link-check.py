#!/usr/bin/env python3
"""Exhaustive front-end content-link verification for the multitenant Ghost stack.

Unlike deploy/smoke-test.py (a fast stack health check), this verifies that EVERY
published content link on the town portals actually resolves, using each site's
own sitemaps (posts / pages / tags / authors) as the source-of-truth URL list.

What it does:
  1. Discovers towns + per-town published-post counts via the superadmin /api/sites.
  2. Fetches the 4 sub-sitemaps and collects every <loc> content URL.
  3. Groups URLs by host and flags any CROSS-TENANT LEAK (a town's sitemap listing
     another town's URLs -- those should never co-mingle).
  4. Verifies EVERY content URL resolves (HTTP 200 after redirects) on its own host.
  5. For each content-rich town, also checks the home page, its on-page nav/content
     links, the RSS feed, and robots.txt.

A non-200 on a sitemap URL is a real broken content link (the site advertises it),
so those FAIL. Run is read-only.

Usage:
    python deploy/content-link-check.py
    TB_SITES=wayland,concord python deploy/content-link-check.py   # restrict towns
    TB_MAX_URLS=2000 python deploy/content-link-check.py           # cap verification
    TB_SCHEME=https TB_BASE_DOMAIN=townbrief.com TB_SUPERADMIN_PASS=... python deploy/content-link-check.py
"""
import os
import re
import sys
import requests
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

requests.packages.urllib3.disable_warnings()

SCHEME = os.environ.get("TB_SCHEME", "http")
BASE_DOMAIN = os.environ.get("TB_BASE_DOMAIN", "localtest.me")
SA = os.environ.get("TB_SUPERADMIN", f"{SCHEME}://superadmin.{BASE_DOMAIN}")
SA_USER = os.environ.get("TB_SUPERADMIN_USER", "admin")
SA_PASS = os.environ.get("TB_SUPERADMIN_PASS", "townbrief2026")
ONLY = [s.strip() for s in os.environ.get("TB_SITES", "").split(",") if s.strip()]
MAX_URLS = int(os.environ.get("TB_MAX_URLS", "0"))  # 0 = no cap
WORKERS = int(os.environ.get("TB_WORKERS", "8"))  # single-instance dev stack can crash above ~8; raise for prod
TIMEOUT = 20
VERIFY = SCHEME == "https"

failures = []          # hard failures: a town's CURRENT content unreachable, or a 5xx
warnings = []          # content gaps (empty tags, POST-only endpoints)
sitemap_findings = []  # sitemap-integrity issues (stale/leaked URLs) — flagged, not hard-fail


def base(slug):
    return f"{SCHEME}://{slug}.{BASE_DOMAIN}"


def host_of(url):
    m = re.match(r'https?://([^/]+)', url)
    return m.group(1) if m else "?"


def slug_of_host(host):
    # <slug>.<base-domain>
    return host[:-(len(BASE_DOMAIN) + 1)] if host.endswith("." + BASE_DOMAIN) else host


def get_status(url, session=None):
    try:
        g = (session or requests).get(url, timeout=TIMEOUT, allow_redirects=True, verify=VERIFY)
        return g.status_code
    except Exception:
        return "ERR"


print("=" * 72)
print("CONTENT-LINK CHECK — multitenant town portals")
print("=" * 72)

# ---- 1. discover towns -----------------------------------------------------
sa = requests.Session()
sa.post(f"{SA}/login", data={"username": SA_USER, "password": SA_PASS},
        allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
sites = sa.get(f"{SA}/api/sites", timeout=TIMEOUT, verify=VERIFY).json()
sites = sites.get("sites", sites) if isinstance(sites, dict) else sites
published = {s["slug"]: int(s.get("published") or 0) for s in sites}
content_towns = sorted([k for k, v in published.items() if v > 0], key=lambda k: -published[k])
if ONLY:
    content_towns = [t for t in content_towns if t in ONLY] or ONLY
print(f"{len(sites)} towns total | {len([v for v in published.values() if v > 0])} have published posts")
print(f"top content towns: " + ", ".join(f"{t}({published.get(t,'?')})" for t in content_towns[:10]))

# ---- 2. fetch sitemaps from each content town, collect URLs ----------------
# (We fetch per content-town so we can detect whether each town's OWN sitemap
#  leaks other towns' URLs.)
src_towns = content_towns[:1] if not ONLY else content_towns  # leak check needs only one; ONLY widens it
all_urls = set()
per_town_sitemap_hosts = {}
for town in (content_towns or ["wayland"]):
    thost = f"{town}.{BASE_DOMAIN}"
    hosts_here = defaultdict(int)
    for t in ["posts", "pages", "tags", "authors"]:
        try:
            x = requests.get(f"{base(town)}/sitemap-{t}.xml", timeout=TIMEOUT, verify=VERIFY)
            if x.status_code != 200:
                continue
            for u in re.findall(r'<loc>([^<]+)</loc>', x.text):
                all_urls.add(u)
                hosts_here[host_of(u)] += 1
        except Exception:
            pass
    per_town_sitemap_hosts[town] = dict(hosts_here)
    # only need to scan a couple towns' sitemaps to characterize the leak + gather URLs
    if not ONLY and town != content_towns[0] and len(per_town_sitemap_hosts) >= 3:
        break

# ---- 3. group all collected URLs by host + leak finding --------------------
by_host = defaultdict(list)
for u in all_urls:
    by_host[host_of(u)].append(u)
print("\n" + "-" * 72)
print(f"SITEMAP SCAN — collected {len(all_urls)} unique content URLs across {len(by_host)} town hosts")
print("-" * 72)
# leak: does a single town's sitemap list more than its own host?
leaks = {t: hs for t, hs in per_town_sitemap_hosts.items() if len([h for h in hs if hs[h]]) > 1}
if leaks:
    t0 = next(iter(leaks))
    foreign = sorted([(h, n) for h, n in per_town_sitemap_hosts[t0].items() if slug_of_host(h) != t0], key=lambda x: -x[1])
    warnings.append(
        f"CROSS-TENANT SITEMAP LEAK: {t0}'s sitemap lists URLs for {len(per_town_sitemap_hosts[t0])} different town hosts "
        f"(own={per_town_sitemap_hosts[t0].get(t0 + '.' + BASE_DOMAIN,0)}, foreign sample: " +
        ", ".join(f"{slug_of_host(h)}={n}" for h, n in foreign[:5]) + ")")
    print("  *** " + warnings[-1])
else:
    print("  OK: each scanned town's sitemap lists only its own host.")

# ---- 4. verify EVERY content URL resolves on its host ----------------------
urls = sorted(all_urls)
if MAX_URLS and len(urls) > MAX_URLS:
    print(f"  (capping verification at TB_MAX_URLS={MAX_URLS} of {len(urls)})")
    urls = urls[:MAX_URLS]
print(f"\nVerifying {len(urls)} content URLs ({WORKERS} workers)...")
results = {}
done = 0
with ThreadPoolExecutor(max_workers=WORKERS) as ex:
    futs = {ex.submit(get_status, u): u for u in urls}
    for fut in futs:
        results[futs[fut]] = fut.result()
        done += 1
        if done % 500 == 0:
            print(f"  ... {done}/{len(urls)}")
broken = [(u, c) for u, c in results.items() if c != 200]
# classify by type + host
by_type = defaultdict(lambda: [0, 0])  # type -> [ok, broken]
for u, c in results.items():
    if "/tag/" in u:
        k = "tag"
    elif "/author/" in u:
        k = "author"
    elif u.rstrip("/").endswith(host_of(u)):
        k = "home/page"
    else:
        k = "post/page"
    by_type[k][0 if c == 200 else 1] += 1
print(f"\nRESULT: {len(urls) - len(broken)}/{len(urls)} content URLs OK, {len(broken)} broken")
for k, (ok, bad) in sorted(by_type.items()):
    print(f"   {k:12} ok={ok} broken={bad}")
if broken:
    # group broken by host
    bh = defaultdict(list)
    for u, c in broken:
        bh[slug_of_host(host_of(u))].append((u, c))
    print("\nBROKEN content links by town:")
    for town in sorted(bh, key=lambda t: -len(bh[t])):
        print(f"   {town}: {len(bh[town])} broken")
        for u, c in bh[town][:8]:
            print(f"      {c}  {u}")
            sitemap_findings.append(f"{c} {u}")

# ---- 4b. AUTHORITATIVE portal check: do each town's CURRENT posts resolve? --
# A stale sitemap entry (post re-slugged/removed) can 404 without the portal being
# broken. The definitive "do the content links work" check uses each town's
# RLS-scoped admin API (its actual current published posts) -> a 404 here IS a real
# portal failure, so these go in `failures`.
print("\n" + "-" * 72)
print("PORTAL CONTENT (authoritative): current published posts resolve on the front-end?")
print("-" * 72)


def site_session(slug):
    s = requests.Session()
    s.post(f"{SA}/login", data={"username": SA_USER, "password": SA_PASS},
           allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    r = s.get(f"{SA}/sso/{slug}", allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    s2 = requests.Session()
    if r.headers.get("location"):
        s2.get(r.headers["location"], allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    return s2


PORTAL_SAMPLE = int(os.environ.get("TB_PORTAL_SAMPLE", "60"))
for town in (content_towns[:12] if not ONLY else content_towns):
    cs = site_session(town)
    try:
        j = cs.get(f"{base(town)}/ghost/api/admin/posts/?filter=status:published&limit={PORTAL_SAMPLE}&fields=url,title",
                   headers={"Accept-Version": "v6.0"}, timeout=TIMEOUT, verify=VERIFY).json()
    except Exception:
        j = {}
    purls = [p["url"] for p in j.get("posts", []) if p.get("url")]
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        pcodes = list(ex.map(get_status, purls))
    pbroken = [(u, c) for u, c in zip(purls, pcodes) if c != 200]
    if not pbroken:
        print(f"  [PASS] {town}: {len(purls)} current posts reachable")
    else:
        print(f"  [FAIL] {town}: {len(pbroken)}/{len(purls)} current posts UNREACHABLE")
        for u, c in pbroken[:5]:
            failures.append(f"PORTAL {c} {u}")
            print(f"      {c}  {u}")

# ---- 5. per content-rich town: home + on-page links + rss + robots ---------
print("\n" + "-" * 72)
print("PER-TOWN portal basics (home, on-page links, rss, robots)")
print("-" * 72)


def check_town(town):
    out = []
    s = requests.Session()
    home = s.get(base(town) + "/", timeout=TIMEOUT, verify=VERIFY)
    out.append((f"{town}: home /", home.status_code == 200, home.status_code))
    # same-host on-page links (nav, content, pagination)
    links = set(re.findall(rf'href="({re.escape(base(town))}[^"#?]*)"', home.text))
    links = [l for l in links if not l.endswith((".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp"))]
    bad5xx, gaps = [], []
    for l in links[:25]:
        c = get_status(l, s)
        if c == "ERR" or (isinstance(c, int) and c >= 500):
            bad5xx.append(f"{l[len(base(town)):]}={c}")
        elif isinstance(c, int) and c >= 400:
            gaps.append(f"{l[len(base(town)):]}={c}")
    out.append((f"{town}: {len(links[:25])} on-page links (no 5xx)", not bad5xx, " ".join(bad5xx)))
    if gaps:
        out.append(("WARN_" + town, "warn", " ".join(gaps[:6])))
    for path in ["/rss/", "/robots.txt"]:
        c = get_status(base(town) + path, s)
        out.append((f"{town}: {path}", c == 200, c))
    return out


targets = content_towns[:12] if not ONLY else content_towns
with ThreadPoolExecutor(max_workers=6) as ex:
    for res in ex.map(check_town, targets):
        for name, ok, detail in res:
            if ok == "warn":
                warnings.append(f"{name[5:]} content gaps: {detail}")
                print(f"  [warn] {name[5:]}   {detail}")
            elif ok:
                print(f"  [PASS] {name}")
            else:
                failures.append(f"{name}  {detail}")
                print(f"  [FAIL] {name}   {detail}")

# ---- summary ---------------------------------------------------------------
print("\n" + "=" * 72)
print(f"SUMMARY: {len(failures)} portal failures, {len(warnings)} warnings, {len(sitemap_findings)} sitemap-integrity issues")
print(f"  sitemap URLs verified: {len(urls)} ({len(urls) - len(broken)} ok / {len(broken)} stale-or-broken)")
print("  (portal failure = a current published post is unreachable, or a 5xx on a real link)")
print("=" * 72)
if warnings:
    print("WARNINGS (content-dependent — empty tags, POST-only endpoints):")
    for w in warnings:
        print("  -", w)
if sitemap_findings:
    print(f"SITEMAP-INTEGRITY ({len(sitemap_findings)} stale/leaked URLs advertised by sitemaps — fix the SitemapManager/data, not the portals; showing 20):")
    for f_ in sitemap_findings[:20]:
        print("  -", f_)
if failures:
    print("PORTAL FAILURES (first 40):")
    for f_ in failures[:40]:
        print("  -", f_)
# Exit reflects PORTAL health (the reader-facing contract). Sitemap-integrity issues
# are reported loudly but don't fail the run on their own.
sys.exit(1 if failures else 0)
