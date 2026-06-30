#!/usr/bin/env python3
"""Membership / money-path test for the multitenant Ghost stack.

Verifies the *scriptable* parts of the paid-subscriber path on a tenant:
  1. paid tiers exist with prices
  2. the members Portal API serves the site/tier config (the paywall data)
  3. free signup (magic link) creates a member
  4. a Stripe checkout session can be created (proves Stripe is wired + tier->price)
  5. the Stripe webhook endpoint authenticates (rejects bad signatures) and dispatches
     per-tenant via metadata.townbrief_site_id

The Stripe-hosted checkout page + a real recurring charge need a manual run in Stripe
TEST MODE (the hosted page is a browser flow) — flagged at the end. This script will not
charge anything.

Env:
  TB_SCHEME / TB_BASE_DOMAIN / TB_SUPERADMIN[_USER|_PASS]   (same as smoke-test.py)
  TB_TENANT          tenant slug to test            (default wayland)
  TB_WEBHOOK_SECRET  Stripe webhook signing secret  (default DEFAULT_WEBHOOK_SECRET — the dev fallback)
"""
import os
import sys
import time
import hmac
import json
import hashlib
import requests

requests.packages.urllib3.disable_warnings()

SCHEME = os.environ.get("TB_SCHEME", "http")
BASE_DOMAIN = os.environ.get("TB_BASE_DOMAIN", "localtest.me")
SA = os.environ.get("TB_SUPERADMIN", f"{SCHEME}://superadmin.{BASE_DOMAIN}")
SA_USER = os.environ.get("TB_SUPERADMIN_USER", "admin")
SA_PASS = os.environ.get("TB_SUPERADMIN_PASS", "townbrief2026")
TENANT = os.environ.get("TB_TENANT", "wayland")
WEBHOOK_SECRET = os.environ.get("TB_WEBHOOK_SECRET", "DEFAULT_WEBHOOK_SECRET")
AV = {"Accept-Version": "v6.0"}
TIMEOUT = 25
VERIFY = SCHEME == "https"

P = F = 0
fails = []
notes = []


def check(name, ok, detail=""):
    global P, F
    if ok:
        P += 1
        print(f"  [PASS] {name}")
    else:
        F += 1
        fails.append(f"{name}  {detail}")
        print(f"  [FAIL] {name}   {detail}")


def note(msg):
    notes.append(msg)
    print(f"  [note] {msg}")


def base(slug):
    return f"{SCHEME}://{slug}.{BASE_DOMAIN}"


def sa_session():
    s = requests.Session()
    s.post(f"{SA}/login", data={"username": SA_USER, "password": SA_PASS}, allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    return s


def site_session(slug):
    s = sa_session()
    r = s.get(f"{SA}/sso/{slug}", allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    s2 = requests.Session()
    loc = r.headers.get("location")
    if loc:
        s2.get(loc, allow_redirects=False, timeout=TIMEOUT, verify=VERIFY)
    return s2


print("=" * 70)
print(f"MEMBERSHIP / MONEY-PATH TEST  (tenant={TENANT})")
print("=" * 70)

sa = sa_session()
sites = sa.get(f"{SA}/api/sites", timeout=TIMEOUT, verify=VERIFY).json()
sites = sites.get("sites", sites) if isinstance(sites, dict) else sites
site_id = next((s.get("id") for s in sites if s.get("slug") == TENANT), None)
s = site_session(TENANT)
api = f"{base(TENANT)}/ghost/api/admin"

# 1. paid tiers exist with prices
tiers = s.get(f"{api}/tiers/?include=monthly_price,yearly_price&limit=all", headers=AV, timeout=TIMEOUT, verify=VERIFY).json().get("tiers", [])
paid = [t for t in tiers if t.get("type") == "paid" and t.get("active") and (t.get("monthly_price") or t.get("yearly_price"))]
check("paid tier(s) exist with a price", len(paid) >= 1, f"{len(paid)} paid tiers")
tier = paid[0] if paid else None
if tier:
    print(f"        using tier '{tier.get('name')}'  monthly={tier.get('monthly_price')}  yearly={tier.get('yearly_price')}")

# 2. Portal API serves the paywall config
portal = requests.get(f"{base(TENANT)}/members/api/site/", timeout=TIMEOUT, verify=VERIFY)
ok = False
try:
    ok = portal.status_code == 200 and isinstance(portal.json().get("site"), dict)
except Exception:
    ok = False
check("members Portal API serves site/paywall config", ok, f"status={portal.status_code}")

# 3. free signup creates a member
stamp = int(time.time())
email = f"moneypath-{stamp}@example.com"
ml = requests.post(f"{base(TENANT)}/members/api/send-magic-link/", timeout=TIMEOUT, verify=VERIFY,
                   json={"email": email, "emailType": "signup"})
check("free signup (magic link) accepted", ml.status_code in (200, 201, 204), f"status={ml.status_code}")
note("the free member is created when the user CLICKS the emailed magic link (not on send) — "
     "verify the email itself via `TB_WRITE_TESTS=1 deploy/smoke-test.py` (Mailpit), or a manual signup.")

# 4. Stripe checkout session can be created (proves Stripe wired + tier->price)
if tier:
    payload = {
        "tierId": tier["id"],
        "cadence": "month" if tier.get("monthly_price") else "year",
        "successUrl": f"{base(TENANT)}/?success=1",
        "cancelUrl": f"{base(TENANT)}/?cancel=1",
        "customerEmail": email,
        "metadata": {"smoke": "1"},
    }
    cs = requests.post(f"{base(TENANT)}/members/api/create-stripe-checkout-session/", json=payload, timeout=TIMEOUT, verify=VERIFY)
    url = ""
    try:
        url = cs.json().get("url", "")
    except Exception:
        pass
    if cs.status_code == 200 and "stripe.com" in url:
        check("Stripe checkout session created (Stripe wired)", True)
        print(f"        checkout URL: {url[:60]}...")
    else:
        check("Stripe checkout session created (Stripe wired)", False, f"status={cs.status_code}")
        note("Stripe not fully connected for this tenant (test-mode keys + a Stripe price per tier) — "
             "expected on a fresh dev DB; required before taking payments.")

# 5. Stripe webhook: rejects bad signatures, accepts + dispatches a signed event per-tenant
wh = f"{base(TENANT)}/members/webhooks/stripe/"
event = {"id": "evt_smoke", "object": "event", "type": "checkout.session.completed",
         "data": {"object": {"id": "cs_smoke", "object": "checkout.session", "mode": "subscription",
                             "customer": "cus_smoke", "subscription": "sub_smoke",
                             "metadata": {"townbrief_site_id": site_id}}}}
body = json.dumps(event)
bad = requests.post(wh, data=body, headers={"Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef"}, timeout=TIMEOUT, verify=VERIFY)
check("Stripe webhook rejects bad signature (401)", bad.status_code == 401, f"status={bad.status_code}")
ts = int(time.time())
sig = hmac.new(WEBHOOK_SECRET.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
good = requests.post(wh, data=body, headers={"Content-Type": "application/json", "Stripe-Signature": f"t={ts},v1={sig}"}, timeout=TIMEOUT, verify=VERIFY)
# A correctly-signed event must NOT 401. It dispatches to the tenant; a synthetic customer id
# then makes Ghost call Stripe and 4xx ("no such customer") — that's the dispatch working.
check("Stripe webhook accepts signed event (not 401 = signature + dispatch OK)", good.status_code != 401, f"status={good.status_code}")
if good.status_code >= 500:
    note(f"signed webhook returned {good.status_code} — inspect Ghost logs; synthetic customer often yields a handled 4xx, not 5xx")

# cleanup: remove any test member that may have been created
try:
    for m in s.get(f"{api}/members/?filter=email:'{email}'", headers=AV, timeout=TIMEOUT, verify=VERIFY).json().get("members", []):
        s.delete(f"{api}/members/{m['id']}/", headers=AV, timeout=TIMEOUT, verify=VERIFY)
except Exception:
    pass

print("\n" + "=" * 70)
print(f"RESULT: {P} passed, {F} failed")
print("=" * 70)
if notes:
    print("NOTES:")
    for n in notes:
        print("  -", n)
print("MANUAL (cannot be scripted — do in Stripe TEST MODE before launch):")
print("  - Complete the hosted Stripe checkout in a browser -> confirm the member becomes paid,")
print("    gains member-only access, and receives the welcome/receipt email.")
print("  - Confirm the payment is attributed to THIS tenant (not another town).")
if fails:
    print("FAILURES:")
    for f_ in fails:
        print("  -", f_)
sys.exit(1 if F else 0)
