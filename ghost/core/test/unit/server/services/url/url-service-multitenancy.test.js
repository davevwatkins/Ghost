const assert = require('node:assert/strict');
const sinon = require('sinon');

const UrlService = require('../../../../../core/server/services/url/url-service');
const {runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');

// Phase 6b: defense-in-depth filtering of URL service lookups by the
// active site. Until the URL service itself is per-site (Phase 4c4b),
// the cache holds ALL sites' resources — we filter at every public
// lookup so cross-site hits behave like "not found" / "not owned".

const SITE_A = 'sitea0000000000000000000';
const SITE_B = 'siteb0000000000000000000';

function mkResource(siteId, type = 'posts', id = 'p_' + Math.random().toString(36).slice(2)) {
    return {
        config: {type},
        data: {id, site_id: siteId}
    };
}

function setupService({resourcesByUrl = {}, resourcesById = {}, urlGenerators = []} = {}) {
    const svc = new UrlService({});
    svc.finished = true;
    svc.urlGenerators = urlGenerators;
    // Replace the internal urls store with a stub that returns our fixtures.
    svc.urls = {
        getByUrl(url) {
            return resourcesByUrl[url] || [];
        },
        getByResourceId(id) {
            return resourcesById[id];
        }
    };
    return svc;
}

describe('UNIT: UrlService (Phase 6b cross-site filter)', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('getResource', function () {
        it('returns the active site\'s resource when a URL collides across sites', async function () {
            const resourceA = mkResource(SITE_A, 'posts', 'a1');
            const resourceB = mkResource(SITE_B, 'posts', 'b1');
            const svc = setupService({
                resourcesByUrl: {
                    '/hello/': [
                        {url: '/hello/', generatorId: 'g1', resource: resourceA},
                        {url: '/hello/', generatorId: 'g1', resource: resourceB}
                    ]
                },
                urlGenerators: [{uid: 'g1'}]
            });

            const fromA = await runWithSite({id: SITE_A}, () => svc.getResource('/hello/'));
            const fromB = await runWithSite({id: SITE_B}, () => svc.getResource('/hello/'));
            assert.equal(fromA?.data?.id, 'a1');
            assert.equal(fromB?.data?.id, 'b1');
        });

        it('returns null when only cross-site resources exist for a URL', async function () {
            const resourceB = mkResource(SITE_B, 'posts', 'b1');
            const svc = setupService({
                resourcesByUrl: {
                    '/sudbury-only/': [{url: '/sudbury-only/', generatorId: 'g1', resource: resourceB}]
                },
                urlGenerators: [{uid: 'g1'}]
            });

            const out = await runWithSite({id: SITE_A}, () => svc.getResource('/sudbury-only/'));
            assert.equal(out, null);
        });

        it('returns the resource in system scope (no active site)', function () {
            const resourceA = mkResource(SITE_A, 'posts', 'a1');
            const svc = setupService({
                resourcesByUrl: {
                    '/whatever/': [{url: '/whatever/', generatorId: 'g1', resource: resourceA}]
                },
                urlGenerators: [{uid: 'g1'}]
            });
            assert.equal(svc.getResource('/whatever/')?.data?.id, 'a1');
        });
    });

    describe('getResourceById', function () {
        it('returns the resource when active site matches', async function () {
            const resourceA = mkResource(SITE_A, 'posts', 'a1');
            const svc = setupService({
                resourcesById: {a1: {url: '/x/', resource: resourceA}}
            });
            const out = await runWithSite({id: SITE_A}, () => svc.getResourceById('a1'));
            assert.equal(out?.data?.id, 'a1');
        });

        it('throws NotFoundError for cross-site resource id', function () {
            const resourceB = mkResource(SITE_B, 'posts', 'b1');
            const svc = setupService({
                resourcesById: {b1: {url: '/x/', resource: resourceB}}
            });
            // getResourceById is synchronous and throws — propagates
            // through runWithSite (which uses AsyncLocalStorage.run).
            assert.throws(
                () => runWithSite({id: SITE_A}, () => svc.getResourceById('b1')),
                /Resource not found/
            );
        });
    });

    describe('getUrlByResourceId', function () {
        it('returns the URL when active site matches', async function () {
            const resourceA = mkResource(SITE_A, 'posts', 'a1');
            const svc = setupService({
                resourcesById: {a1: {url: '/x/', resource: resourceA}}
            });
            const url = await runWithSite({id: SITE_A}, () => svc.getUrlByResourceId('a1'));
            assert.equal(url, '/x/');
        });

        it('returns /404/ when resource belongs to another site', async function () {
            const resourceB = mkResource(SITE_B, 'posts', 'b1');
            const svc = setupService({
                resourcesById: {b1: {url: '/x/', resource: resourceB}}
            });
            const url = await runWithSite({id: SITE_A}, () => svc.getUrlByResourceId('b1'));
            assert.equal(url, '/404/');
        });
    });

    describe('owns', function () {
        it('returns true when the active site matches', async function () {
            const resourceA = mkResource(SITE_A, 'posts', 'a1');
            const svc = setupService({
                resourcesById: {a1: {url: '/x/', resource: resourceA}},
                urlGenerators: [{identifier: 'r1', hasId: id => id === 'a1'}]
            });
            const owns = await runWithSite({id: SITE_A}, () => svc.owns('r1', 'a1'));
            assert.equal(owns, true);
        });

        it('returns false for cross-site resource', async function () {
            const resourceB = mkResource(SITE_B, 'posts', 'b1');
            const svc = setupService({
                resourcesById: {b1: {url: '/x/', resource: resourceB}},
                urlGenerators: [{identifier: 'r1', hasId: id => id === 'b1'}]
            });
            const owns = await runWithSite({id: SITE_A}, () => svc.owns('r1', 'b1'));
            assert.equal(owns, false);
        });

        it('returns false when router does not have the id at all (sanity)', async function () {
            const svc = setupService({
                urlGenerators: [{identifier: 'r1', hasId: () => false}]
            });
            const owns = await runWithSite({id: SITE_A}, () => svc.owns('r1', 'whatever'));
            assert.equal(owns, false);
        });
    });
});
