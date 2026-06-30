const urlUtils = require('../../../shared/url-utils');
let sitemapsUtils;

sitemapsUtils = {
    getDeclarations: function () {
        let baseUrl = urlUtils.urlFor('sitemap_xsl', true);
        baseUrl = baseUrl.replace(/^(http:|https:)/, '');
        return '<?xml version="1.0" encoding="UTF-8"?>' +
            '<?xml-stylesheet type="text/xsl" href="' + baseUrl + '"?>';
    },

    // TownBrief multitenancy: the sitemap generators are a single global singleton
    // (see site-map-manager.js / handler.js — `new Manager()` once at module load),
    // so their node lookups accumulate URLs for EVERY tenant. These helpers let each
    // generator emit only the active (requested) site's URLs, keyed off that site's
    // absolute base URL — which urlUtils resolves from the active-site context, the
    // same way the index generator already does for sub-sitemap URLs. Without this,
    // one town's sitemap leaks every other town's URLs (cross-tenant) and lists
    // stale cross-site slugs.
    getActiveSiteBaseUrl: function () {
        try {
            let base = urlUtils.urlFor({relativeUrl: '/'}, true);
            if (base && !base.endsWith('/')) {
                base += '/';
            }
            return base || null;
        } catch (err) {
            return null;
        }
    },

    locBelongsToSite: function (loc, base) {
        // No active-site context (boot, background jobs, REPL) -> don't filter, so
        // behaviour outside a request is unchanged.
        if (!base) {
            return true;
        }
        if (typeof loc !== 'string') {
            return false;
        }
        // `base` carries a trailing slash; match the site root exactly (no slash) OR
        // any path under it. The trailing slash prevents prefix collisions between
        // sibling subdomains (e.g. wayland vs waylandfoo).
        return loc === base.slice(0, -1) || loc.startsWith(base);
    }
};

module.exports = sitemapsUtils;
