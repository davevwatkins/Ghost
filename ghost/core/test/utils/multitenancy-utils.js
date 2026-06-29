// TownBrief multitenancy Phase 10: shared test helpers for writing
// tenant-aware tests. The pre-Phase-2 test suite assumes a single
// tenant; many tests just work because the Phase 1.6 default-site
// boot hook seeds a default site row and the Phase 3 plugin treats
// system scope as "see everything." Tests that EXERCISE multitenancy
// (cross-site isolation, per-site config, etc.) use these helpers to
// make a second/third site fixture and run the test body inside the
// right runWithSite scope.
//
// Usage patterns:
//
//   // Wrap a test body in a site scope (unit + integration):
//   const {withSite} = require('../utils/multitenancy-utils');
//   it('reads from the active site', withSite(SITE_A, async () => {
//       const post = await models.Post.findOne({id: 'p1'});
//       // ... assertions ...
//   }));
//
//   // Create a fresh test site (integration tests with DB):
//   const {createTestSite} = require('../utils/multitenancy-utils');
//   const sudbury = await createTestSite({slug: 'sudbury-test', host: 's.test'});
//
//   // Quick fake site for unit tests (no DB write):
//   const {fakeSite} = require('../utils/multitenancy-utils');
//   const siteA = fakeSite('site-a');
//   await runWithSite(siteA, () => myCode());

const ObjectID = require('bson-objectid').default;
const {runWithSite, getCurrentSiteId} = require('../../core/server/services/multitenancy/current-site');

const DEFAULT_SITE_ID = 'default0000000000000000';

/**
 * Mocha test wrapper: wraps an `it` callback so the body runs inside
 * runWithSite. Use when you need the active-site context (Phase 3
 * plugin scoping, Phase 4a settings cache, Phase 4b urlUtils,
 * Phase 1.5b RLS GUC) to be a specific site for the test.
 *
 * @param {object|string} siteOrId - a site object {id, slug, host, ...} or a bare id string
 * @param {Function} testFn - the test body
 * @returns {Function} a mocha-compatible test function
 */
function withSite(siteOrId, testFn) {
    const site = typeof siteOrId === 'string' ? {id: siteOrId} : siteOrId;
    return function wrappedTest() {
        return runWithSite(site, () => testFn.call(this));
    };
}

/**
 * Builds a fake site object suitable for unit tests that don't touch
 * the DB but DO exercise multitenancy code paths (settings cache
 * lookups, urlUtils per-site, theme cache per-site, etc.).
 *
 * @param {string} slug - human-friendly slug, also seeds the id
 * @returns {{id: string, slug: string, host: string, custom_domain: null, status: 'active'}}
 */
function fakeSite(slug = 'test') {
    const id = (slug.padEnd(24, '0')).slice(0, 24);
    return {id, slug, host: `${slug}.test`, custom_domain: null, status: 'active'};
}

/**
 * Integration test helper — create a real site row + 118 default
 * settings + roles/permissions seeded from the default site. Wraps
 * the work in a transaction so a failure leaves no half-state.
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} [opts.name]
 * @param {string} [opts.host] - defaults to `<slug>.test`
 * @param {boolean} [opts.seedAuthModel=true] - seed roles+permissions+permissions_roles
 * @returns {Promise<{id, slug, name, host, status}>}
 */
async function createTestSite(opts = {}) {
    const db = require('../../core/server/data/db');
    const {seedRolesAndPermissionsForSite} = require('../../core/server/services/multitenancy/site-seeders');
    const defaultSettings = require('../../core/server/data/schema/default-settings');

    const slug = opts.slug || `test-${(new ObjectID()).toHexString().slice(0, 8)}`;
    const name = opts.name || slug;
    const host = opts.host || `${slug}.test`;
    const siteId = (new ObjectID()).toHexString();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await db.knex.transaction(async (trx) => {
        await trx('sites').insert({
            id: siteId, slug, name, host,
            custom_domain: null, status: 'active',
            stripe_account_id: null, mailgun_from: null,
            created_at: now, updated_at: now
        });

        const settingRows = [];
        for (const groupName of Object.keys(defaultSettings)) {
            for (const key of Object.keys(defaultSettings[groupName])) {
                const def = defaultSettings[groupName][key];
                let value = def.defaultValue;
                if (value === undefined) value = null;
                if (value !== null && typeof value === 'object') value = JSON.stringify(value);
                else if (value !== null) value = String(value);
                settingRows.push({
                    id: (new ObjectID()).toHexString(),
                    site_id: siteId,
                    group: groupName,
                    key,
                    value,
                    type: def.type || 'string',
                    flags: def.flags || null,
                    created_at: now,
                    updated_at: now
                });
            }
        }
        await trx.batchInsert('settings', settingRows, 100);

        if (opts.seedAuthModel !== false) {
            await seedRolesAndPermissionsForSite(trx, siteId);
        }
    });

    return {id: siteId, slug, name, host, status: 'active'};
}

/**
 * Integration test cleanup — destroy a test site and everything that
 * cascades from it. Wraps in transaction; idempotent on missing site.
 */
async function destroyTestSite(siteId) {
    if (!siteId || siteId === DEFAULT_SITE_ID) return;
    const db = require('../../core/server/data/db');
    await db.knex.transaction(async (trx) => {
        // ON DELETE CASCADE handles the per-site rows in dependent
        // tables. Just drop the site row and the FK cascades.
        await trx('sites').where('id', siteId).del();
    });
}

/**
 * Assertion helper for cross-tenant isolation tests:
 * `await assertScopedTo(siteId, async () => { ... })` runs the body
 * inside runWithSite and confirms the AsyncLocalStorage was actually
 * set. Catches accidental mis-wrapping.
 */
function assertScopedTo(siteId, fn) {
    const assert = require('node:assert/strict');
    return runWithSite({id: siteId}, async () => {
        assert.equal(getCurrentSiteId(), siteId,
            `Test was expected to run inside runWithSite(${siteId}) but the AsyncLocalStorage is ${getCurrentSiteId()}`);
        return fn();
    });
}

module.exports = {
    withSite,
    fakeSite,
    createTestSite,
    destroyTestSite,
    assertScopedTo,
    DEFAULT_SITE_ID
};
