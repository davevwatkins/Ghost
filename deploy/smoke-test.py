#!/usr/bin/env python3
"""Multitenant Ghost stack smoke test (TownBrief fork).

Post-deploy / post-change regression check that exercises the whole stack across
several representative tenant sites plus the superadmin launcher:

  1. Gateway + admin HTML shell + every admin asset (the rebuilt React admin)
  2. The admin API battery — every endpoint the admin loads, per site
  3. Single sign-on — one superadmin login covers all sites, cookieless bounce,
     and launcher section deep-links (?next=)
  4. The superadmin launcher — its pages and every API endpoint, + auth gate
  5. Front-end public pages (home, sitemap, RSS) and same-site links
  6. Cross-tenant isolation (a session on one host can't authenticate on another)

Stack failures (5xx, auth breaks, missing assets) FAIL the run. Content gaps
(e.g. a nav link to a tag with no posts yet -> 404) are reported as warnings,
not failures, because they depend on editorial content, not the platform.

Usage:
    # Dev (defaults target the localtest.me dev stack):
    python deploy/smoke-test.py

    # Production:
    TB_SCHEME=https TB_BASE_DOMAIN=townbrief.com \
    TB_SUPERADMIN=https://superadmin.townbrief.com \
    TB_SUPERADMIN_PASS='<superadmin password>' \
    TB_SITES=wayland,concord,middlesexcounty \
    python deploy/smoke-test.py

Env vars:
    TB_SCHEME            http | https           (default http)
    TB_BASE_DOMAIN       base domain            (default localtest.me)
    TB_SUPERADMIN        superadmin base URL    (default {scheme}://superadmin.{base})
    TB_SUPERADMIN_USER   launcher username      (default admin)
    TB_SUPERADMIN_PASS   launcher password      (default townbrief2026 — dev only)
    TB_SITES             comma-separated slugs  (default concord,wayland,massachusetts,middlesexcounty)

Exit code 0 = all stack checks passed (warnings allowed); 1 = a stack check failed.
"""
import os
import re
import sys
import requests

requests.packages.urllib3.disable_warnings()

SCHEME = os.environ.get("TB_SCHEME", "http")
BASE_DOMAIN = os.environ.get("TB_BASE_DOMAIN", "localtest.me")
SA = os.environ.get("TB_SUPERADMIN", f"{SCHEME}://superadmin.{BASE_DOMAIN}")
SA_USER = os.environ.get("TB_SUPERADMIN_USER", "admin")
SA_PASS = os.environ.get("TB_SUPERADMIN_PASS", "townbrief2026")
SITES = [s.strip() for s in os.environ.get(
    "TB_SITES", "concord,wayland,massachusetts,middlesexcounty").split(",") if s.strip()]
AV = {"Accept-Version": "v6.0"}
TIMEOUT = 25
VERIFY = SCHEME == "https"  # allow self-signed in dev; verify in prod

P = F = W = 0
fails = []
warns = []


def check(name, ok, detail=""):
    global P, F
    if ok:
        P += 1
        print(f"  [PASS] {name}")
    else:
        F += 1
        fails.append(f"{name}  {detail}")
        print(f"  [FAIL] {name}   {detail}")


def warn(name, detail=""):
    global W
    W += 1
    warns.append(f"{name}  {detail}")
    print(f"  [warn] {name}   {detail}")


def base(slug):
    return f"{SCHEME}://{slug}.{BASE_DOMAIN}"


def sa_session():
    s = requests.Session()
    s.post(f"{SA}/login", data={"username": SA_USER, "password": SA_PASS},
           allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    return s


def site_session(slug):
    """Fresh per-site admin session via the cross-site SSO redeem."""
    s = sa_session()
    r = s.get(f"{SA}/sso/{slug}", allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    s2 = requests.Session()
    loc = r.headers.get("location")
    if loc:
        s2.get(loc, allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    return s2


# Every endpoint the admin actually loads. (No /webhooks/ — Ghost has no webhooks
# *list* endpoint; the admin reads them via /integrations/?include=webhooks.)
ADMIN_ENDPOINTS = [
    "/site/", "/config/",
    "/users/me/?include=roles.permissions",
    "/settings/?group=site,theme,members,portal,newsletter,email,labs,comments,analytics,explore,donations,recommendations,announcement,editor,unsplash,security,social_web",
    "/themes/", "/integrations/?include=api_keys,webhooks",
    "/newsletters/?include=count.active_members,count.posts&limit=all",
    "/tiers/?include=monthly_price,yearly_price,benefits&limit=all",
    "/labels/?limit=all", "/roles/?permissions=assign",
    "/custom_theme_settings/", "/snippets/?limit=all",
    "/users/?limit=all&include=roles", "/invites/?limit=all",
    "/pages/?limit=15&include=tags,authors",
    "/posts/?limit=15&include=tags,authors&order=updated_at%20desc",
    "/members/?limit=15&include=newsletters,labels,tiers&order=created_at%20desc",
    "/tags/?limit=15&include=count.posts", "/offers/", "/notifications/",
    "/actions/?limit=15&include=actor,resource",
    "/tinybird/token/",
    "/stats/member_count/", "/stats/mrr/", "/stats/subscriptions/",
    "/stats/top-posts-views/?date_from=2026-01-01&date_to=2026-12-31&limit=5&timezone=UTC",
    "/links/?limit=5",
    "/members/events/?limit=5",
    "/explore/",
]
KNOWN_BAD = []  # no remaining known-bad endpoints


def section(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


section("SECTION 1 - Gateway, admin HTML shell + assets (per site)")
for slug in SITES:
    s = site_session(slug)
    r = s.get(f"{base(slug)}/ghost/?sso=1", allow_redirects=True, timeout=TIMEOUT, verify=VERIFY)
    check(f"{slug}: /ghost shell",
          r.status_code == 200 and ('id="root"' in r.text or "ember-load" in r.text),
          f"status={r.status_code} bytes={len(r.text)}")
    assets = re.findall(r'assets/[^"\s]+\.(?:js|css)', r.text)
    bad = []
    for a in assets:
        code = s.get(f"{base(slug)}/ghost/{a}", timeout=TIMEOUT, verify=VERIFY).status_code
        if code != 200:
            bad.append(f"{a}={code}")
    check(f"{slug}: {len(assets)} admin assets load", not bad, ",".join(bad))

section("SECTION 2 - Admin API battery (every endpoint the admin loads)")
for slug in SITES:
    s = site_session(slug)
    b = f"{base(slug)}/ghost/api/admin"
    bad = []
    for ep in ADMIN_ENDPOINTS:
        try:
            code = s.get(b + ep, headers=AV, timeout=TIMEOUT, verify=VERIFY).status_code
        except Exception as e:
            code = f"ERR({str(e)[:20]})"
        if code != 200:
            bad.append(f"{ep.split('?')[0]}={code}")
    check(f"{slug}: {len(ADMIN_ENDPOINTS)} admin API endpoints", not bad, " ".join(bad))
    kb = [f"{ep.split('?')[0]}={s.get(b + ep, headers=AV, timeout=TIMEOUT, verify=VERIFY).status_code}" for ep in KNOWN_BAD]
    if kb:
        print(f"        (known-bug endpoints, {slug}: {' '.join(kb)})")

section("SECTION 3 - Single sign-on flows")
s = sa_session()
for slug in SITES:
    s.get(f"{base(slug)}/ghost", allow_redirects=True, timeout=TIMEOUT, verify=VERIFY)
    me = s.get(f"{base(slug)}/ghost/api/admin/users/me/?include=roles", headers=AV, timeout=TIMEOUT, verify=VERIFY)
    check(f"auto-SSO: {slug} (one login)", me.status_code == 200, f"users/me={me.status_code}")
s3 = requests.Session()
r = s3.get(f"{base(SITES[0])}/ghost", allow_redirects=True, timeout=TIMEOUT, verify=VERIFY)
check("auto-SSO: cookieless visit -> superadmin /login", "/login" in r.url and "superadmin" in r.url, r.url)
sa = sa_session()
for route, enc in [("/ghost/#/posts", "%2Fghost%2F%23%2Fposts"),
                   ("/ghost/#/members", "%2Fghost%2F%23%2Fmembers"),
                   ("/ghost/#/settings", "%2Fghost%2F%23%2Fsettings")]:
    r1 = sa.get(f"{SA}/sso/{SITES[0]}?next={enc}", allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    s2 = requests.Session()
    r2 = s2.get(r1.headers["location"], allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    check(f"deep-link -> {route}", r2.headers.get("location") == route, f"got {r2.headers.get('location')}")

section("SECTION 4 - Superadmin launcher (pages + every API endpoint)")
s = sa_session()
dash = s.get(f"{SA}/", timeout=TIMEOUT, verify=VERIFY).text
for sect in ["sites", "content", "members", "settings", "pipeline"]:
    check(f"launcher dashboard has '{sect}' section", f"section==='{sect}'" in dash)
for ep, key in [("/api/me", "user"), ("/api/sites", "sites"),
                ("/api/content?type=post&page=1", "posts"),
                ("/api/members?status=all&page=1", "members"),
                (f"/api/sites/{SITES[0]}/settings", None), ("/api/pipeline", None)]:
    r = s.get(f"{SA}{ep}", timeout=TIMEOUT, verify=VERIFY)
    ok = r.status_code == 200
    if ok and key:
        try:
            ok = key in r.json()
        except Exception:
            ok = False
    check(f"launcher {ep.split('?')[0]}", ok, f"status={r.status_code}")
anon = requests.Session().get(f"{SA}/api/sites", timeout=TIMEOUT, verify=VERIFY)
check("launcher /api requires auth", anon.status_code == 401, f"status={anon.status_code}")

section("SECTION 5 - Front-end public pages + links")
for slug in SITES:
    home = requests.get(f"{base(slug)}/", timeout=TIMEOUT, verify=VERIFY)
    check(f"{slug}: front-end /", home.status_code == 200, f"status={home.status_code}")
    links = set(re.findall(rf'href="({SCHEME}://{re.escape(slug)}\.{re.escape(BASE_DOMAIN)}[^"#?]+)"', home.text))
    links = [l for l in links if not l.endswith((".css", ".js", ".png", ".jpg", ".svg", ".ico"))][:8]
    server_errs, content_gaps = [], []
    for l in links:
        try:
            c = requests.get(l, timeout=TIMEOUT, allow_redirects=True, verify=VERIFY).status_code
            if c >= 500:
                server_errs.append(f"{l[len(base(slug)):]}={c}")
            elif c >= 400:
                content_gaps.append(f"{l[len(base(slug)):]}={c}")
        except Exception:
            server_errs.append(f"{l}=ERR")
    check(f"{slug}: {len(links)} front-end links (no 5xx)", not server_errs, " ".join(server_errs))
    if content_gaps:
        warn(f"{slug}: front-end content gaps (empty tags / POST-only endpoints)", " ".join(content_gaps))
    for path in ["/sitemap.xml", "/rss/"]:
        c = requests.get(f"{base(slug)}{path}", timeout=TIMEOUT, verify=VERIFY).status_code
        check(f"{slug}: {path}", c == 200, f"status={c}")

section("SECTION 6 - Cross-tenant isolation (RLS)")
if len(SITES) >= 2:
    cs = site_session(SITES[0])
    own = cs.get(f"{base(SITES[0])}/ghost/api/admin/posts/?limit=1", headers=AV, timeout=TIMEOUT, verify=VERIFY)
    other = cs.get(f"{base(SITES[1])}/ghost/api/admin/posts/?limit=1", headers=AV, timeout=TIMEOUT, verify=VERIFY)
    check(f"isolation: {SITES[0]} session on own host = 200", own.status_code == 200, f"{own.status_code}")
    check(f"isolation: {SITES[0]} cookie on {SITES[1]} host != 200 (no cross-host auth)",
          other.status_code != 200, f"{SITES[1]}={other.status_code}")

# ---- SECTION 7 (writes; gated by TB_WRITE_TESTS) — publish -> front-end -> email ----
# Off by default (creates + deletes a test post and triggers an email). Run with
# TB_WRITE_TESTS=1. Email lands in Mailpit on dev; in prod it only checks the send was
# accepted (verify real inbox delivery manually / via your ESP dashboard).
if os.environ.get("TB_WRITE_TESTS"):
    import time as _time
    import subprocess as _sub
    import json as _json

    def _mailpit_count():
        try:
            r = _sub.run(["docker", "exec", os.environ.get("TB_MAILPIT", "ghost-dev-mailpit"),
                          "wget", "-qO-", "http://localhost:8025/api/v1/messages"],
                         capture_output=True, text=True, timeout=10)
            j = _json.loads(r.stdout)
            return j.get("messages_count", j.get("total"))
        except Exception:
            return None

    section("SECTION 7 - Publish -> front-end -> email (writes; TB_WRITE_TESTS=1)")
    town = SITES[0]
    s = site_session(town)
    api = f"{base(town)}/ghost/api/admin"
    stamp = int(_time.time())
    body = f"smoke-test body {stamp} (safe to delete)"
    post_id = None
    try:
        cr = s.post(f"{api}/posts/?source=html", headers=AV, timeout=TIMEOUT, verify=VERIFY,
                    json={"posts": [{"title": f"SMOKE-TEST {stamp}", "html": f"<p>{body}</p>", "status": "published"}]})
        post = (cr.json().get("posts") or [{}])[0]
        post_id, post_url = post.get("id"), post.get("url")
        check(f"{town}: create + publish post", cr.status_code in (200, 201) and bool(post_id), f"status={cr.status_code}")
        if post_url:
            fr = requests.get(post_url, timeout=TIMEOUT, verify=VERIFY)
            check(f"{town}: published post renders on front-end", fr.status_code == 200 and body in fr.text, f"status={fr.status_code}")
    except Exception as e:
        check(f"{town}: create + publish post", False, str(e)[:60])

    test_email = f"smoke-{stamp}@example.com"
    before = _mailpit_count()
    ml = requests.post(f"{base(town)}/members/api/send-magic-link/", timeout=TIMEOUT, verify=VERIFY,
                       json={"email": test_email, "emailType": "signup"})
    check(f"{town}: magic-link email send accepted", ml.status_code in (200, 201, 204), f"status={ml.status_code}")
    if before is not None:
        _time.sleep(2)
        after = _mailpit_count()
        check(f"{town}: outbound email captured (Mailpit)", (after or 0) > (before or 0), f"before={before} after={after}")
    else:
        warn(f"{town}: email delivery", "Mailpit unreachable — verify real inbox delivery in prod")

    if post_id:
        dr = s.delete(f"{api}/posts/{post_id}/", headers=AV, timeout=TIMEOUT, verify=VERIFY)
        check(f"{town}: cleanup test post", dr.status_code in (200, 204), f"status={dr.status_code}")
    try:
        for mem in s.get(f"{api}/members/?filter=email:'{test_email}'", headers=AV, timeout=TIMEOUT, verify=VERIFY).json().get("members", []):
            s.delete(f"{api}/members/{mem['id']}/", headers=AV, timeout=TIMEOUT, verify=VERIFY)
    except Exception:
        pass

print("\n" + "=" * 70)
print(f"RESULT: {P} passed, {F} failed, {W} warnings")
print("=" * 70)
if warns:
    print("WARNINGS (content-dependent, not stack failures):")
    for w in warns:
        print("  -", w)
if fails:
    print("FAILURES:")
    for f_ in fails:
        print("  -", f_)
sys.exit(1 if F else 0)
