const assert = require('node:assert/strict');
const sinon = require('sinon');

const {
    withSite,
    fakeSite,
    assertScopedTo,
    DEFAULT_SITE_ID
} = require('../../utils/multitenancy-utils');
const {getCurrentSiteId} = require('../../../core/server/services/multitenancy/current-site');

// Phase 10: smoke tests for the multitenancy test helpers themselves.
// Real Ghost-test-suite retrofits use these helpers to wrap individual
// tests in a known site scope; if the helpers misbehave the whole
// retrofit drifts. So the helpers themselves are tested first.

describe('UNIT: multitenancy-utils (Phase 10 test helpers)', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('fakeSite', function () {
        it('builds a 24-char id derived from the slug', function () {
            const s = fakeSite('alpha');
            assert.equal(s.id.length, 24);
            assert.ok(s.id.startsWith('alpha'));
            assert.equal(s.slug, 'alpha');
            assert.equal(s.host, 'alpha.test');
        });

        it('truncates long slugs to 24 chars for id', function () {
            const s = fakeSite('extremely-long-slug-name-here');
            assert.equal(s.id.length, 24);
        });

        it('defaults slug to "test" when called without args', function () {
            const s = fakeSite();
            assert.equal(s.slug, 'test');
            assert.equal(s.host, 'test.test');
        });
    });

    describe('withSite', function () {
        it('returns a mocha-compatible test function', function () {
            const wrapped = withSite(fakeSite('a'), function () { /* noop */ });
            assert.equal(typeof wrapped, 'function');
        });

        it('runs the body inside runWithSite scoped to the given site', async function () {
            const site = fakeSite('beta');
            let observed = null;
            const wrapped = withSite(site, async function () {
                observed = getCurrentSiteId();
            });
            await wrapped();
            assert.equal(observed, site.id);
        });

        it('accepts a bare id string', async function () {
            let observed = null;
            const wrapped = withSite('mysite0000000000000000aa', async function () {
                observed = getCurrentSiteId();
            });
            await wrapped();
            assert.equal(observed, 'mysite0000000000000000aa');
        });

        it('does not leak the active site beyond the wrapped body', async function () {
            const wrapped = withSite(fakeSite('gamma'), async function () { /* noop */ });
            await wrapped();
            assert.equal(getCurrentSiteId(), null);
        });

        it('preserves mocha `this` binding (test context)', async function () {
            let observed = null;
            const wrapped = withSite(fakeSite('delta'), async function () {
                observed = this.testProp;
            });
            await wrapped.call({testProp: 'hello'});
            assert.equal(observed, 'hello');
        });
    });

    describe('assertScopedTo', function () {
        it('asserts the runWithSite scope is correct + runs the body', async function () {
            const site = fakeSite('epsilon');
            let bodyRan = false;
            await assertScopedTo(site.id, async () => {
                bodyRan = true;
                assert.equal(getCurrentSiteId(), site.id);
            });
            assert.ok(bodyRan);
        });

        it('propagates body errors', async function () {
            await assert.rejects(
                assertScopedTo('site_x0000000000000000000', async () => {
                    throw new Error('body kaboom');
                }),
                /body kaboom/
            );
        });
    });

    describe('DEFAULT_SITE_ID', function () {
        it('matches the production constant', function () {
            assert.equal(DEFAULT_SITE_ID, 'default0000000000000000');
        });
    });
});
