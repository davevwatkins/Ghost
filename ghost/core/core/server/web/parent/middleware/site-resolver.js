const debug = require('@tryghost/debug')('web:site-resolver');
const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const db = require('../../../data/db');
const {runWithSite} = require('../../../services/multitenancy/current-site');

const messages = {
    noSiteForHost: 'No active site is configured for host "{host}".'
};

// Simple in-process cache. Site rows change rarely (provisioning + admin
// edits only), so a 60s TTL keeps the per-request lookup at zero queries in
// steady state. add-site / admin edits should call invalidate() to force a
// refresh; until that's wired up, the TTL is the floor on staleness.
const TTL_MS = 60 * 1000;
const cache = new Map();

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.value;
}

function cacheSet(key, value) {
    cache.set(key, {value, expiresAt: Date.now() + TTL_MS});
}

function invalidate() {
    cache.clear();
}

// Strip ":port" and lowercase for stable matching against sites.host /
// sites.custom_domain. We do NOT strip subdomain dots — `wayland.townbrief.com`
// and `townbrief.com` are different sites.
function normaliseHost(rawHost) {
    if (!rawHost) return null;
    return String(rawHost).toLowerCase().split(':')[0].trim();
}

async function lookupSite(host) {
    const cached = cacheGet(host);
    if (cached !== undefined) return cached;

    // Match either the canonical `host` column or the optional `custom_domain`.
    // Both columns are unique, so this returns at most one row.
    const row = await db.knex('sites')
        .where(function () {
            this.where('host', host).orWhere('custom_domain', host);
        })
        .andWhere('status', 'active')
        .first('id', 'slug', 'name', 'host', 'custom_domain', 'status', 'stripe_account_id', 'mailgun_from');

    cacheSet(host, row || null);
    return row || null;
}

// Express middleware. Must run before any handler that touches the DB or
// renders site-specific output. The first thing in the parent app pipeline
// after request-id / logging.
function siteResolver(req, res, next) {
    const host = normaliseHost(req.headers.host);
    if (!host) {
        return next(new errors.BadRequestError({message: 'Missing Host header'}));
    }

    lookupSite(host).then((site) => {
        if (!site) {
            debug(`No site for host "${host}"`);
            return next(new errors.NotFoundError({
                message: tpl(messages.noSiteForHost, {host})
            }));
        }

        debug(`Host "${host}" -> site "${site.slug}" (${site.id})`);
        // TownBrief Phase 6 debug: surface site resolution in regular
        // logs so we can confirm host->site dispatch end-to-end. Remove
        // once the per-site frontend is settled.
        const logging = require('@tryghost/logging');
        logging.info(`[site-resolver] Host="${host}" -> site_id=${site.id} slug=${site.slug}`);
        // Stash the resolved site on the request for handlers that want it
        // directly, and run the rest of the request inside an
        // AsyncLocalStorage scope so any downstream code (Bookshelf models,
        // services) can read the active site_id without threading it
        // through every call signature.
        req.site = site;
        runWithSite(site, () => next());
    }).catch(next);
}

module.exports = siteResolver;
module.exports.invalidate = invalidate;
