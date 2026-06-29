/* eslint no-invalid-this:0 */
const assert = require('node:assert/strict');
const sinon = require('sinon');
const testUtils = require('../../../../utils');
const knex = require('../../../../../core/server/data/db').knex;
const models = require('../../../../../core/server/models');
const {runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');

// Phase 3b: cross-tenant isolation tests for the Bookshelf multitenancy
// plugin. mock-knex captures the generated SQL so we can verify the plugin
// is injecting the expected `WHERE site_id = ?` and stamping the active
// site on inserts. Dialect note: Knex uses "?" placeholders for the
// captured `bindings` regardless of pg/mysql/sqlite, and the column-quote
// style differs by client — assertions match on the unquoted column path
// (`site_id` appears verbatim in every dialect's SQL string).

const SITE_A = {id: 'sitea00000000000000000aa', slug: 'sitea', host: 'a.test'};
const SITE_B = {id: 'siteb00000000000000000bb', slug: 'siteb', host: 'b.test'};

describe('Models: multitenancy plugin (Phase 3)', function () {
    const mockDb = require('../../../../utils/mock-knex');
    let tracker;

    before(function () {
        mockDb.mock(knex);
        tracker = mockDb.getTracker();
    });

    afterEach(function () {
        sinon.restore();
    });

    after(function () {
        mockDb.unmock(knex);
    });

    describe('fetching', function () {
        it('adds site_id WHERE clause to Post.findAll when a site is active', async function () {
            const queries = [];
            tracker.install();
            tracker.on('query', (query) => {
                queries.push(query);
                query.response([]);
            });

            await runWithSite(SITE_A, () => models.Post.findAll());

            assert.ok(queries.length >= 1, 'expected at least one query');
            const sql = queries[0].sql;
            assert.ok(/posts.+site_id/i.test(sql),
                `expected site_id WHERE in SQL, got: ${sql}`);
            assert.ok(queries[0].bindings.includes(SITE_A.id),
                `expected site A id in bindings, got: ${JSON.stringify(queries[0].bindings)}`);
        });

        it('does NOT add site_id WHERE clause when no site is active', async function () {
            const queries = [];
            tracker.install();
            tracker.on('query', (query) => {
                queries.push(query);
                query.response([]);
            });

            await models.Post.findAll();

            assert.ok(queries.length >= 1, 'expected at least one query');
            const sql = queries[0].sql;
            assert.ok(!/posts.+site_id/i.test(sql),
                `expected no site_id WHERE in SQL (system scope), got: ${sql}`);
        });

        it('does NOT add site_id WHERE when context.allowCrossSite is true', async function () {
            // Ghost's filterOptions strips top-level options not in the
            // permitted-options whitelist, so opt-out is routed through
            // options.context.allowCrossSite which always survives.
            const queries = [];
            tracker.install();
            tracker.on('query', (query) => {
                queries.push(query);
                query.response([]);
            });

            await runWithSite(SITE_A, () => models.Post.findAll({
                context: {allowCrossSite: true}
            }));

            assert.ok(queries.length >= 1, 'expected at least one query');
            const sql = queries[0].sql;
            assert.ok(!/posts.+site_id/i.test(sql),
                `expected no site_id WHERE in SQL with allowCrossSite, got: ${sql}`);
        });

        it('does NOT scope queries on UNSCOPED tables (sites itself)', async function () {
            // Direct query through knex to the sites table — Bookshelf
            // doesn't currently have a Site model (Phase 5+), so we test via
            // the underlying connection. Just sanity-check that nothing in
            // the plugin tries to scope `sites` itself.
            const queries = [];
            tracker.install();
            tracker.on('query', (query) => {
                queries.push(query);
                query.response([{id: SITE_A.id}]);
            });

            await runWithSite(SITE_A, () => knex('sites').where('id', SITE_A.id).first());

            assert.ok(queries.length >= 1);
            // Raw knex queries don't go through Bookshelf, so no scoping
            // is attempted on them — this test guards against any future
            // attempt to hook into knex itself.
            assert.ok(!/sites\.site_id/i.test(queries[0].sql),
                `sites table must not be self-scoped, got: ${queries[0].sql}`);
        });
    });

    describe('creating', function () {
        it('stamps active site_id on insert via the creating hook', function () {
            // Use the plugin's hook directly rather than going through
            // Post.add, which pulls in user/auth/permission machinery that's
            // out of scope for this test. Forge a minimal post and trigger
            // the hook with the same shape Bookshelf would.
            const post = models.Post.forge({
                title: 'Test',
                site_id: SITE_B.id // caller wants B
            });
            const attrs = {title: 'Test', site_id: SITE_B.id};

            return runWithSite(SITE_A, async () => {
                post.onCreatingSiteScoped(post, attrs, {});
                assert.equal(post.get('site_id'), SITE_A.id,
                    'creating hook should overwrite caller-supplied site_id with active');
            });
        });
    });
});
