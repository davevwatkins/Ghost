const UrlUtils = require('@tryghost/url-utils');
const config = require('./config');

// TownBrief multitenancy Phase 4b: per-site URLs.
// UrlUtils is constructed ONCE and reads `getSiteUrl`/`getAdminUrl`
// lazily — every call into the builder invokes those functions. So
// rather than maintain a cache of N UrlUtils instances, we override
// `getSiteUrl` to read the active site from AsyncLocalStorage. The
// underlying UrlUtils stays a singleton, but URLs come out
// site-correct on every request.
//
// Admin URL stays global — TownBrief uses one shared admin UI with a
// site picker (see SHARED-IDENTITY.md / future Phase 5 work). If
// per-site admin URLs are ever needed, mirror the getSiteUrl pattern
// here for getAdminUrl.
//
// Lazy require so url-utils can load before the multitenancy service.
let _getCurrentSite;
function getCurrentSite() {
    if (!_getCurrentSite) {
        try {
            _getCurrentSite = require('../server/services/multitenancy/current-site').getCurrentSite;
        } catch (e) {
            return null;
        }
    }
    return _getCurrentSite();
}

function deriveOriginFromConfig() {
    // Best-effort guess from the configured URL. Production sites will
    // typically be HTTPS via Caddy/Let's Encrypt on the default port; dev
    // uses HTTP on a non-default port (e.g. localhost:2368). Carry the
    // non-default port through so per-site origins match what the browser
    // actually sends — CSRF compares them.
    try {
        const configured = config.getSiteUrl();
        const url = new URL(configured);
        const scheme = url.protocol === 'https:' ? 'https' : 'http';
        const isDefaultPort = !url.port ||
            (scheme === 'http' && url.port === '80') ||
            (scheme === 'https' && url.port === '443');
        return {scheme, port: isDefaultPort ? '' : `:${url.port}`};
    } catch (e) {
        return {scheme: 'http', port: ''};
    }
}

function getSiteUrl(...args) {
    const site = getCurrentSite();
    if (site && site.host) {
        const {scheme, port} = deriveOriginFromConfig();
        const host = site.custom_domain || site.host;
        // Match the UrlUtils convention of trailing slash + optional path.
        const subdir = (typeof config.getSubdir === 'function' && config.getSubdir()) || '';
        const base = `${scheme}://${host}${port}${subdir}/`.replace(/\/+$/, '/');
        // UrlUtils sometimes passes a path arg to be appended.
        if (args[0]) {
            return base + String(args[0]).replace(/^\/+/, '');
        }
        return base;
    }
    return config.getSiteUrl(...args);
}

const BASE_API_PATH = '/ghost/api';
const urlUtils = new UrlUtils({
    getSubdir: config.getSubdir,
    getSiteUrl,
    getAdminUrl: config.getAdminUrl,
    assetBaseUrls: {
        media: config.get('urls:media'),
        files: config.get('urls:files'),
        image: config.get('urls:image')
    },
    slugs: config.get('slugs').protected,
    redirectCacheMaxAge: config.get('caching:301:maxAge'),
    baseApiPath: BASE_API_PATH
});

module.exports = urlUtils;
module.exports.BASE_API_PATH = BASE_API_PATH;
// Exposed for direct testing of the multitenancy override; not for general use.
module.exports.__getSiteUrl = getSiteUrl;
