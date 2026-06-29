const assert = require('node:assert/strict');

// Mock the validate + i18n + config deps that ActiveTheme touches so we
// don't load Ghost's full theme engine for this focused unit test.
const path = require('node:path');

const active = require('../../../../../core/frontend/services/theme-engine/active');
const {runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');

// Minimal loadedTheme + checkedTheme shapes that satisfy ActiveTheme's
// constructor (it reads .name, .path, ['package.json'], .partials,
// .templates).
function mkTheme(name) {
    return {
        loadedTheme: {
            name,
            path: path.join('/tmp/themes', name),
            'package.json': {name, version: '1.0.0'}
        },
        checkedTheme: {
            partials: [],
            templates: {custom: [], all: ['index.hbs']},
            results: {error: []}
        }
    };
}

describe('UNIT: theme-engine/active (Phase 4c multitenancy)', function () {
    beforeEach(function () {
        active.__clearAll();
    });

    it('without runWithSite, set/get use the default bucket', function () {
        const t = mkTheme('casper');
        active.set({locale: 'en'}, t.loadedTheme, t.checkedTheme);
        const got = active.get();
        assert.equal(got.name, 'casper');
    });

    it('set inside runWithSite stores per-site; get returns the right one', async function () {
        const SITE_A = {id: 'aaa00000000000000000000a', slug: 'a', host: 'a.test'};
        const SITE_B = {id: 'bbb00000000000000000000b', slug: 'b', host: 'b.test'};
        const casper = mkTheme('casper');
        const headline = mkTheme('headline');

        await runWithSite(SITE_A, () =>
            active.set({locale: 'en'}, casper.loadedTheme, casper.checkedTheme));
        await runWithSite(SITE_B, () =>
            active.set({locale: 'en'}, headline.loadedTheme, headline.checkedTheme));

        const themeA = await runWithSite(SITE_A, () => active.get());
        const themeB = await runWithSite(SITE_B, () => active.get());
        assert.equal(themeA.name, 'casper');
        assert.equal(themeB.name, 'headline');
        assert.notEqual(themeA, themeB, 'sites must have distinct ActiveTheme instances');
    });

    it('explicit opts.siteId overrides AsyncLocalStorage', async function () {
        const SITE_A = {id: 'aaa00000000000000000000a', slug: 'a', host: 'a.test'};
        const casper = mkTheme('casper');

        // Set into site A explicitly while there's NO active site
        active.set({locale: 'en'}, casper.loadedTheme, casper.checkedTheme, {siteId: SITE_A.id});

        // Outside any runWithSite, default bucket — should be undefined
        assert.equal(active.get(), undefined);

        // With explicit siteId
        assert.equal(active.get({siteId: SITE_A.id}).name, 'casper');

        // Or via runWithSite
        const fromContext = await runWithSite(SITE_A, () => active.get());
        assert.equal(fromContext.name, 'casper');
    });
});
