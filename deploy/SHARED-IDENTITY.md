# TownBrief shared identity & bundled billing (one account across all towns)

Goal: make the fleet feel like **one product** — a reader has **one TownBrief account**,
**one bill**, and can buy **bundles** (a town, several towns, or county all-access), with
**single sign-on** into any town site. Built as a layer *around* the Ghost fleet — **no fork of
Ghost's data layer**, so it stays updatable.

## Why a layer (not native Ghost)

Ghost members, magic-link auth, tiers, and Stripe are **per-instance**. There is no native
cross-instance account, SSO, or bundled subscription. So a small central service owns identity
+ billing, and **projects access into each town's Ghost via its Admin API**.

## The trick: comped members + Admin-API SSO

Two Ghost capabilities make this work without core changes:
1. **Comp a member into a paid tier via Admin API** — the central layer creates/updates a member
   in a town's Ghost as a *complimentary* paid member. Ghost then grants paid access and serves
   the paywalled content; **Ghost itself does no charging** (billing is central).
2. **Mint a member sign-in URL via Admin API** (`/members/{id}/signin_urls/`) — the central layer
   can hand a logged-in user a one-time link that logs them straight into a town's Ghost. That's
   SSO without touching Ghost auth internals.

## Components

```
┌──────────────────────── TownBrief Account (central) ─────────────────────────┐
│  Accounts      identity: email + auth (build, or Clerk/Auth0/Supabase Auth)   │
│  Billing       ONE Stripe acct: products = per-town, multi-town, county all   │
│                webhooks → entitlements                                         │
│  Entitlements  user → {towns:[…], county:bool, tier}                          │
│  Provisioner   entitlements → Ghost members per instance (Admin API):         │
│                  grant  = create/comp member at paid tier                      │
│                  revoke = remove comp / set free                              │
│  SSO bouncer   /go/<town> → Admin API signin_url → redirect (seamless login)  │
└───────────────────────────────────────────────────────────────────────────────┘
        │ Admin API (create/comp member, signin_urls)   │ Content API (read)
        ▼                                                ▼
   ghost-wayland / ghost-sudbury / …              ghost-county (aggregator)
```

- **Accounts**: one login for everything. Fastest to ship on a managed auth (Clerk/Auth0/
  Supabase); or build on the existing fork if you want it fully in-house.
- **Billing**: a single Stripe account centrally (the town instances no longer each need their
  own Stripe). Products model the bundles.
- **Entitlements**: source of truth for who can read what; updated by Stripe webhooks.
- **Provisioner**: idempotent sync — on entitlement change, comp/uncomp the member in exactly
  the town instances they're entitled to.
- **SSO bouncer**: turns "central session" into "town Ghost session" on demand.

## County aggregator (Middlesex County News)

A consumer of every town's **Content API** that presents a combined county feed (headlines +
links/excerpts back to the town sites). Can be its own Ghost instance fed by an aggregation job,
or a small custom front-end. Modest: ~days–1 week. Independent of the identity layer.

## Phased roadmap (each phase ships value; none requires a core fork)

| Phase | What the reader gets | Effort | Notes |
|---|---|---|---|
| **0 — Fleet** (see FLEET.md) | Per-town site, per-town account & billing | ~1–2 wks | Each town self-contained; Stripe per town |
| **1 — Cross-town SSO** | **One login**, still separate per-town subscriptions | +2–3 wks | Central accounts + SSO bouncer; billing stays per-town |
| **2 — Central billing & bundles** | **One account, one bill**, buy town/multi-town/county all-access | +1–2 months | Central Stripe + entitlements + provisioner; town instances switch to comped members |
| **3 — County product** | A county-wide publication over all towns | +days–1 wk | Content-API aggregator; can run in parallel |

## Trade-off to decide up front

- **Per-town Stripe (Phase 0)** — simplest, works today, but no bundles and no single bill.
- **Central Stripe + comped members (Phase 2)** — unlocks bundles/one-account (the real
  differentiator) but you reimplement subscription management centrally (plan changes, dunning,
  proration, the account portal). That's the bulk of the effort and where the product lives.

## What stays out of the fork

Everything here is external services calling Ghost's **public Admin/Content APIs**. The
`townbrief` fork remains for small, isolated UX/core tweaks only — so upstream Ghost updates keep
flowing in cleanly (per TOWNBRIEF-CHANGES.md).

## Risks / open questions

- Admin API `signin_urls` rate limits / token lifetime for SSO at scale — validate early.
- DMARC/sender alignment when one relay sends "from" many town addresses.
- Refunds/cancellations must reliably revoke comps across instances (provisioner must be
  idempotent and webhook-driven, with a reconciliation sweep).
- GDPR/CCPA: one account spanning towns centralizes subscriber PII — plan data handling.
