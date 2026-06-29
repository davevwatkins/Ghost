const config = require('../../../shared/config');
const LocalFileCache = require('./local-file-cache');
const UrlService = require('./url-service');
const UrlServiceFacade = require('./url-service-facade');

// NOTE: instead of a path we could give UrlService a "data-resolver" of some sort
//       so it doesn't have to contain the logic to read data at all. This would be
//       a possible improvement in the future
let writeDisabled = false;
let storagePath = config.getContentPath('data');

// TODO: remove this hack in favor of loading from the content path when it's possible to do so
//       by mocking content folders in pre-boot phase
if (process.env.NODE_ENV.startsWith('test')){
    storagePath = config.get('paths').urlCache;

    // NOTE: prevents test suites from overwriting cache fixtures.
    //       A better solution would be injecting a different implementation of the
    //       cache based on the environment, this approach should do the trick for now
    writeDisabled = true;
}

// TownBrief multitenancy Phase 4c4b: per-site URL service instances.
//
// `urlServicesBySite` holds one UrlService per site_id. The DEFAULT
// instance is created eagerly (matches legacy behavior + survives all
// the boot-time consumers that import this module). Other sites get
// their UrlService created LAZILY via `ensureUrlServiceForSite()` —
// called either at boot when iterating active sites, or at add-site
// provisioning time when a new tenant comes online. Each instance
// initialises inside `runWithSite(site, ...)` so:
//   1) its routes.yaml resolves via Phase 4c4's per-site path resolver
//   2) Bookshelf model auto-scoping (Phase 3) + RLS (Phase 2c) keep
//      resource fetching inside the site's data
//
// Phase 6b's defense-in-depth filter on the UrlService itself is
// still in place — if a per-site instance hasn't been created yet and
// a request falls through to the default-site instance, cross-site
// cache hits still surface as 404 from the filter. That's the
// belt-and-suspenders correctness contract while lazy creation
// catches up.
//
// The module export is a SEPARATE facade object — distinct from the
// default UrlService — so test-suite stubs on the default instance
// don't clobber the dispatch logic. Existing callers that reach for
// `urlService.X` get the facade-dispatched version of X; the original
// default instance is reachable via `urlService.__defaultService` for
// boot init.

const DEFAULT_SITE_ID = 'default0000000000000000';

const urlServicesBySite = new Map();
const defaultCache = new LocalFileCache({storagePath, writeDisabled});
const defaultService = new UrlService({cache: defaultCache});
const defaultFacade = new UrlServiceFacade({urlService: defaultService});
defaultService.facade = defaultFacade;
urlServicesBySite.set(DEFAULT_SITE_ID, defaultService);

let _getCurrentSiteId;
function getCurrentSiteId() {
    if (!_getCurrentSiteId) {
        try {
            _getCurrentSiteId = require('../multitenancy/current-site').getCurrentSiteId;
        } catch (e) { return null; }
    }
    return _getCurrentSiteId();
}

function urlServiceForActiveSite() {
    const siteId = getCurrentSiteId() || DEFAULT_SITE_ID;
    return urlServicesBySite.get(siteId) || defaultService;
}

// Phase 4c4b: create + init a UrlService for a specific site. Called
// from boot.js when iterating over active sites, OR lazily by the
// add-site provisioning flow when a new site comes online. Caller is
// responsible for running inside `runWithSite(site, ...)` so the
// init resolves to the right site's routes + resources.
async function ensureUrlServiceForSite(site, opts = {}) {
    if (!site || !site.id) throw new Error('ensureUrlServiceForSite requires a site object with id');
    if (urlServicesBySite.has(site.id)) return urlServicesBySite.get(site.id);

    const perSiteCache = new LocalFileCache({
        storagePath: `${storagePath}/sites/${site.slug || site.id}`,
        writeDisabled
    });
    const svc = new UrlService({cache: perSiteCache});
    svc.facade = new UrlServiceFacade({urlService: svc});
    urlServicesBySite.set(site.id, svc);

    if (opts.skipInit) return svc;

    // Phase 4c4e: register generators BEFORE calling svc.init().
    //
    // In Ghost's normal boot, routerManager.start() fires synchronously
    // immediately after urlService.init() is called WITHOUT await. That
    // means generators subscribe to the queue BEFORE resources finish
    // loading. The queue's requiredSubscriberCount:1 gate won't open
    // until at least one generator has subscribed — so if we call
    // svc.init() first and wait, no generator ever subscribes, the queue
    // hangs, and the 15s safety-net fires with an empty URL map.
    //
    // Fix: replay the router params (captured by routerManager after
    // initDynamicRouting()) onto the per-site instance FIRST. Generators
    // subscribe to the queue, then svc.init() fetches resources and
    // starts the queue — which now has subscribers and can complete.
    const routerParams = opts.routerParams || [];
    for (const p of routerParams) {
        svc.onRouterAddedType(p.identifier, p.filter, p.resourceType, p.permalink);
    }

    // Fetch resources + start the queue. Generators subscribed above
    // will process resources as they load.
    await svc.init({urlCache: opts.urlCache});

    if (!svc.hasFinished()) {
        await new Promise((resolve) => {
            const onEnded = (event) => {
                if (event === 'init') {
                    svc.queue.removeListener('ended', onEnded);
                    resolve();
                }
            };
            svc.queue.on('ended', onEnded);
            // Safety net: bail after 15 s rather than hanging boot
            // indefinitely if the queue stalls. Phase 6b filter still
            // covers correctness if the instance is incomplete.
            setTimeout(() => {
                svc.queue.removeListener('ended', onEnded);
                resolve();
            }, 15000).unref();
        });
    }

    return svc;
}

// Build the public facade. Lookup methods dispatch to the active
// site's instance; all other properties / methods (init, shutdown,
// queue access, listeners, etc.) flow through to the default instance
// because they're boot-time concerns where per-site distinction
// doesn't yet apply.
const DISPATCHED_METHODS = ['getResource', 'getResourceById', 'getUrlByResourceId', 'owns', 'getPermalinkByUrl', 'hasFinished'];

const moduleFacade = new Proxy({}, {
    get(_target, prop) {
        if (prop === '__defaultService') return defaultService;
        if (prop === '__urlServicesBySite') return urlServicesBySite;
        if (prop === 'ensureUrlServiceForSite') return ensureUrlServiceForSite;
        if (prop === 'facade') {
            // Inner facade is also per-site dispatched.
            return new Proxy({}, {
                get(_t2, fprop) {
                    const svc = urlServiceForActiveSite();
                    const f = svc.facade || defaultFacade;
                    const val = f[fprop];
                    return typeof val === 'function' ? val.bind(f) : val;
                }
            });
        }
        if (DISPATCHED_METHODS.includes(prop)) {
            return function dispatched(...args) {
                const svc = urlServiceForActiveSite();
                if (typeof svc[prop] === 'function') return svc[prop](...args);
                // Fall back to default if active site's instance is incomplete.
                return defaultService[prop](...args);
            };
        }
        // Everything else flows through to the default instance — these
        // are init/queue/listener concerns where there's only one set
        // of orchestration to coordinate at the module level.
        const val = defaultService[prop];
        return typeof val === 'function' ? val.bind(defaultService) : val;
    }
});

module.exports = moduleFacade;
