#!/usr/bin/env python3
"""Edge-cache purge-on-publish bridge for the multitenant Ghost stack.

Receives Ghost content webhooks (Post published / updated / unpublished, Page *,
etc.) and REFRESHES the affected tenant's edge-cache entries by re-fetching them
with `Cache-Control: no-cache`. That header makes Souin bypass the cache, refetch
from Ghost, and re-store the fresh response (verified on dev: a no-cache GET turns
a cached entry into `fwd=uri-miss; stored`, then later requests serve the fresh
copy). No Souin admin API needed — it's plain HTTP.

Host-scoped + per-tenant: it only refreshes URLs on the *post's own host*, so it
can never touch another town's cache. Cache keys are `GET-http-<host>-<path>`, so
hitting the right host is sufficient isolation.

Wire it up (per site, once):
  Ghost Admin -> Settings -> Integrations -> Add custom integration -> Webhooks
    Event:  "Post published"  (also add Post updated / unpublished, Page published/updated)
    Target: http://<bridge-host>:8099/purge
  (Across many tenants, register programmatically via the Admin API / the superadmin
   tool's cross-site access — see deploy/EDGE-CACHING.md.)

Env:
  PURGE_BRIDGE_PORT  listen port (default 8099)
  PURGE_VIA_HOST     optional host:port to send the refresh GETs to (e.g. the gateway
                     `ghost-dev-gateway:80`); the tenant Host header is preserved so
                     the cache key still matches. Default: use the post URL's own host.
"""
import os
import json
import requests  # pip install requests  (urllib/http.client mangle or drop the header; requests sends it verbatim)
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PURGE_BRIDGE_PORT", "8099"))
VIA = os.environ.get("PURGE_VIA_HOST", "").strip()


def refresh(url):
    """GET `url` with `Cache-Control: no-cache` so Souin bypasses the cache, refetches from
    Ghost, and re-stores the fresh entry. Sends the header verbatim (exact `Cache-Control`
    casing is required — Souin ignores urllib's mangled `Cache-control`)."""
    u = urlparse(url)
    target = url
    headers = {"Cache-Control": "no-cache", "User-Agent": "tb-purge-bridge"}
    if VIA:
        # Connect to a fixed gateway address but keep the tenant Host so the cache key matches.
        target = "{}://{}{}".format(u.scheme, VIA, u.path or "/")
        headers["Host"] = u.netloc
    try:
        return requests.get(target, headers=headers, timeout=10).status_code < 500
    except Exception:
        return False


def affected_urls(resource):
    """The set of cache entries a published/edited post or page invalidates."""
    url = resource.get("url")
    if not url:
        return []
    u = urlparse(url)
    base = "{}://{}".format(u.scheme, u.netloc)
    urls = {url, base + "/", base + "/sitemap-posts.xml", base + "/sitemap-pages.xml", base + "/rss/"}
    for t in (resource.get("tags") or []):
        if t.get("slug"):
            urls.add("{}/tag/{}/".format(base, t["slug"]))
    authors = list(resource.get("authors") or [])
    if resource.get("primary_author"):
        authors.append(resource["primary_author"])
    for a in authors:
        if a.get("slug"):
            urls.add("{}/author/{}/".format(base, a["slug"]))
    return sorted(urls)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip("/") != "/purge":
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            data = {}
        # Ghost wraps the changed entity under post/page -> current (and previous on edits).
        res = {}
        for kind in ("post", "page"):
            block = data.get(kind) or {}
            res = block.get("current") or block.get("previous") or res
            if res:
                break
        urls = affected_urls(res)
        refreshed = [u for u in urls if refresh(u)]
        body = json.dumps({"refreshed": refreshed}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # health check
        self.send_response(200 if self.path.rstrip("/") in ("", "/health") else 404)
        self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("purge-bridge listening on :{} (refresh via {})".format(PORT, VIA or "post host"), flush=True)
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
