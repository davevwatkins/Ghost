const assert = require('node:assert/strict');
const sinon = require('sinon');

const urlServiceModule = require('../../../../../core/server/services/url');
const {runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');

// Phase 4c4b: module-level export is now a facade that dispatches the
// public lookup methods (`getResource`, `getResourceById`,
// `getUrlByResourceId`, `owns`, `getPermalinkByUrl`) and `facade.*` to
// the active site's UrlService instance. The default instance still
// receives calls when no site is active OR the active site has no
// instance yet.

const SITE_A = {id: 'sitea0000000000000000000', slug: 'sitea', host: 'a.test'};
const SITE_B = {id: 'siteb0000000000000000000', slug: 'siteb', host: 'b.test'};
const DEFAULT_SITE_ID = 'default0000000000000000';

describe('UNIT: url-service module facade (Phase 4c4b)', function () {
    afterEach(function () {
        sinon.restore();
        // Clean up any test-created per-site UrlServices so the next
        // test starts with just the default instance.
        for (const [siteId] of urlServiceModule.__urlServicesBySite) {
            if (siteId !== DEFAULT_SITE_ID) urlServiceModule.__urlServicesBySite.delete(siteId);
        }
    });

    function stubMethodOnInstance(siteId, method, stub) {
        const svc = urlServiceModule.__urlServicesBySite.get(siteId);
        svc[method] = stub;
    }

    describe('default routing (no active site)', function () {
        it('routes getResource to the default instance', function () {
            const dispatched = sinon.spy();
            stubMethodOnInstance(DEFAULT_SITE_ID, 'getResource', dispatched);
            urlServiceModule.getResource('/foo/');
            sinon.assert.calledOnceWithExactly(dispatched, '/foo/');
        });

        it('routes facade.getUrlForResource to the default facade', function () {
            const dispatched = sinon.stub().returns('/x/');
            urlServiceModule.__urlServicesBySite.get(DEFAULT_SITE_ID).facade = {
                getUrlForResource: dispatched
            };
            const out = urlServiceModule.facade.getUrlForResource({id: 'r1', type: 'posts'});
            assert.equal(out, '/x/');
            sinon.assert.calledOnce(dispatched);
        });
    });

    describe('active-site routing', function () {
        it('routes getResource to the active site\'s instance when one exists', async function () {
            const defaultGet = sinon.spy();
            const siteAGet = sinon.stub().returns({data: {id: 'a1', site_id: SITE_A.id}});
            stubMethodOnInstance(DEFAULT_SITE_ID, 'getResource', defaultGet);
            // Manually populate site A's instance
            await urlServiceModule.ensureUrlServiceForSite(SITE_A, {skipInit: true});
            stubMethodOnInstance(SITE_A.id, 'getResource', siteAGet);

            const out = await runWithSite(SITE_A, () => urlServiceModule.getResource('/foo/'));
            assert.deepEqual(out, {data: {id: 'a1', site_id: SITE_A.id}});
            sinon.assert.calledOnce(siteAGet);
            sinon.assert.notCalled(defaultGet);
        });

        it('falls back to the default instance when active site has no UrlService yet', async function () {
            const defaultGet = sinon.stub().returns({fallback: true});
            stubMethodOnInstance(DEFAULT_SITE_ID, 'getResource', defaultGet);
            // SITE_B is never registered.
            const out = await runWithSite(SITE_B, () => urlServiceModule.getResource('/foo/'));
            assert.deepEqual(out, {fallback: true});
            sinon.assert.calledOnce(defaultGet);
        });

        it('routes facade.getUrlForResource to the active site\'s facade', async function () {
            await urlServiceModule.ensureUrlServiceForSite(SITE_A, {skipInit: true});
            const siteAFacade = sinon.stub().returns('/a/x/');
            const defaultFacade = sinon.stub().returns('/default/x/');
            urlServiceModule.__urlServicesBySite.get(SITE_A.id).facade = {
                getUrlForResource: siteAFacade
            };
            urlServiceModule.__urlServicesBySite.get(DEFAULT_SITE_ID).facade = {
                getUrlForResource: defaultFacade
            };

            const fromA = await runWithSite(SITE_A, () => urlServiceModule.facade.getUrlForResource({id: 'r1'}));
            const fromB = urlServiceModule.facade.getUrlForResource({id: 'r2'}); // no scope
            assert.equal(fromA, '/a/x/');
            assert.equal(fromB, '/default/x/');
        });
    });

    describe('ensureUrlServiceForSite', function () {
        it('returns the same instance for repeat calls (idempotent)', async function () {
            const svc1 = await urlServiceModule.ensureUrlServiceForSite(SITE_A, {skipInit: true});
            const svc2 = await urlServiceModule.ensureUrlServiceForSite(SITE_A, {skipInit: true});
            assert.strictEqual(svc1, svc2);
        });

        it('throws when called without site.id', async function () {
            await assert.rejects(
                urlServiceModule.ensureUrlServiceForSite(null),
                /requires a site object with id/
            );
            await assert.rejects(
                urlServiceModule.ensureUrlServiceForSite({}),
                /requires a site object with id/
            );
        });

        it('stores in the per-site map', async function () {
            assert.equal(urlServiceModule.__urlServicesBySite.has(SITE_A.id), false);
            await urlServiceModule.ensureUrlServiceForSite(SITE_A, {skipInit: true});
            assert.equal(urlServiceModule.__urlServicesBySite.has(SITE_A.id), true);
        });
    });
});
