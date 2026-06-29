const {AsyncLocalStorage} = require('async_hooks');

// TownBrief multitenancy: AsyncLocalStorage carrying the currently-active
// site_id for the request (or scheduled-job context). The host-resolver
// middleware in web/parent/middleware/site-resolver.js stamps this at the
// top of every HTTP request. Bookshelf base-model overrides (Phase 3) read
// it on every query to scope to the active site.
//
// `getCurrentSiteId()` returns null if called outside a runWithSite() scope
// — by design. Callers that legitimately need cross-site access (superadmin
// tooling, migrations, scheduled jobs that fan out) must opt in explicitly
// rather than silently leaking across tenants.

const storage = new AsyncLocalStorage();

function runWithSite(site, fn) {
    if (!site || !site.id) {
        throw new Error('runWithSite() requires a site object with an id');
    }
    return storage.run({siteId: site.id, site}, fn);
}

// Run `fn` outside any active-site scope. The connection hook will
// set `app.site_id` to '', which makes `current_site_id()` return
// NULL and the RLS policies fall through to their "no scope = system
// scope" branch. Use ONLY for legitimate cross-site reads (superadmin
// tooling, cross-site SSO secret lookup, migrations, etc.) — these
// callers must NOT touch tenant data without explicit per-row site_id
// filters of their own.
function runWithoutSite(fn) {
    return storage.run(undefined, fn);
}

function getCurrentSiteId() {
    const store = storage.getStore();
    return store ? store.siteId : null;
}

function getCurrentSite() {
    const store = storage.getStore();
    return store ? store.site : null;
}

function requireCurrentSiteId() {
    const id = getCurrentSiteId();
    if (!id) {
        throw new Error('No active site in context. Wrap the call in runWithSite() or fix the request pipeline.');
    }
    return id;
}

module.exports = {
    runWithSite,
    runWithoutSite,
    getCurrentSiteId,
    getCurrentSite,
    requireCurrentSiteId
};
