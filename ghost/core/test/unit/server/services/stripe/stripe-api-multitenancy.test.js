const assert = require('node:assert/strict');
const sinon = require('sinon');

const config = require('../../../../../core/shared/config');
const StripeAPI = require('../../../../../core/server/services/stripe/stripe-api');
const {runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');

// Phase 4d2: verify the per-request URL builder reads the ACTIVE site's
// URL (not the boot-captured one) and that townbrief_site_id metadata
// is stamped on every outbound Stripe payload.

const SITE_A = {id: 'sitea0000000000000000000', slug: 'sitea', host: 'a.test'};
const SITE_B = {id: 'siteb0000000000000000000', slug: 'siteb', host: 'b.test'};

describe('UNIT: stripe-api (Phase 4d2 multitenancy)', function () {
    const {activeSiteUrlWithStripeParam, stampSiteIdMetadata} = StripeAPI.__phase4d2;

    beforeEach(function () {
        // Pin a config-default URL — the per-site override should override this.
        sinon.stub(config, 'getSiteUrl').returns('http://localhost:2368/');
        sinon.stub(config, 'getSubdir').returns('');
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('activeSiteUrlWithStripeParam', function () {
        it('falls back to the configured default site URL when no site is active', function () {
            const url = activeSiteUrlWithStripeParam('success');
            assert.equal(url, 'http://localhost:2368/?stripe=success');
        });

        it('uses the active site host inside runWithSite', async function () {
            const url = await runWithSite(SITE_A, () => activeSiteUrlWithStripeParam('success'));
            assert.equal(url, 'http://a.test/?stripe=success');
        });

        it('produces distinct URLs for different active sites', async function () {
            const a = await runWithSite(SITE_A, () => activeSiteUrlWithStripeParam('cancel'));
            const b = await runWithSite(SITE_B, () => activeSiteUrlWithStripeParam('cancel'));
            assert.equal(a, 'http://a.test/?stripe=cancel');
            assert.equal(b, 'http://b.test/?stripe=cancel');
            assert.notEqual(a, b);
        });

        it('applies the supplied search param', async function () {
            const url = await runWithSite(SITE_A, () => activeSiteUrlWithStripeParam('return'));
            assert.ok(url.endsWith('?stripe=return'));
        });
    });

    describe('stampSiteIdMetadata', function () {
        it('adds townbrief_site_id when a site is active', async function () {
            const m = await runWithSite(SITE_A, () => stampSiteIdMetadata({foo: 'bar'}));
            assert.equal(m.townbrief_site_id, SITE_A.id);
            assert.equal(m.foo, 'bar');
        });

        it('returns the input untouched when no site is active', function () {
            const m = stampSiteIdMetadata({foo: 'bar'});
            assert.equal(m.foo, 'bar');
            assert.equal(m.townbrief_site_id, undefined);
        });

        it('returns undefined when input is undefined and no site is active', function () {
            assert.equal(stampSiteIdMetadata(undefined), undefined);
        });

        it('returns a new object with site_id when input is undefined but site is active', async function () {
            const m = await runWithSite(SITE_B, () => stampSiteIdMetadata(undefined));
            assert.equal(m.townbrief_site_id, SITE_B.id);
        });

        it('does not mutate the input object', async function () {
            const original = {foo: 'bar'};
            const out = await runWithSite(SITE_A, () => stampSiteIdMetadata(original));
            assert.equal(original.townbrief_site_id, undefined, 'input must not be mutated');
            assert.equal(out.townbrief_site_id, SITE_A.id);
        });
    });
});
