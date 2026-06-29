const assert = require('node:assert/strict');
const sinon = require('sinon');

// Resolve module paths before any lazy loads occur.
const SETTINGS_CACHE_PATH = require.resolve('../../../../../core/shared/settings-cache');
const CURRENT_SITE_PATH = require.resolve('../../../../../core/server/services/multitenancy/current-site');
const SSO_PATH = require.resolve('../../../../../core/server/services/multitenancy/cross-site-sso');

// Phase 5d: mint / verify / find-or-create-mirror unit tests.
//
// getSigningSecret() now reads from the in-memory settings-cache
// (not knex), so we inject a settings-cache stub via the require
// cache rather than providing a fake settings DB row. The knex param
// is still used by findOrCreateMirrorUser for user/roles lookups.

function makeFakeKnex({users = [], roles = []} = {}) {
    const rowsFor = (table) => {
        if (table === 'users') return users;
        if (table === 'roles') return roles;
        return [];
    };
    const k = (table) => ({
        where: sinon.stub().returnsThis(),
        andWhere: sinon.stub().returnsThis(),
        first: sinon.stub().callsFake(() => Promise.resolve(rowsFor(table)[0] || null)),
        insert: sinon.stub().resolves()
    });
    k.transaction = async (fn) => fn(k);
    return k;
}

describe('UNIT: cross-site-sso (Phase 5d)', function () {
    let sso;
    let getCacheStub;

    beforeEach(function () {
        // Inject a settings-cache stub so getSigningSecret() returns the
        // test secret without hitting a real DB or in-memory cache.
        getCacheStub = sinon.stub().returns('unit-test-secret');
        delete require.cache[SETTINGS_CACHE_PATH];
        require.cache[SETTINGS_CACHE_PATH] = {
            id: SETTINGS_CACHE_PATH,
            filename: SETTINGS_CACHE_PATH,
            loaded: true,
            exports: {get: getCacheStub}
        };

        // runWithoutSite() passthrough — we're testing SSO logic, not RLS scoping.
        delete require.cache[CURRENT_SITE_PATH];
        require.cache[CURRENT_SITE_PATH] = {
            id: CURRENT_SITE_PATH,
            filename: CURRENT_SITE_PATH,
            loaded: true,
            exports: {runWithoutSite: async (fn) => fn(), getCurrentSiteId: () => null}
        };

        // Fresh sso module so lazy requires pick up the stubs above.
        delete require.cache[SSO_PATH];
        sso = require(SSO_PATH);
    });

    afterEach(function () {
        sso.__resetNonceStore();
        sinon.restore();
        delete require.cache[SSO_PATH];
        delete require.cache[SETTINGS_CACHE_PATH];
        delete require.cache[CURRENT_SITE_PATH];
    });

    describe('mint + verify happy path', function () {
        it('round-trips through sign+verify', async function () {
            const {token} = await sso.mintToken({userId: 'u1', targetSiteId: 's1'});
            const decoded = await sso.verifyAndConsumeToken({token});
            assert.equal(decoded.userId, 'u1');
            assert.equal(decoded.targetSiteId, 's1');
        });

        it('embeds an expiration within 60s of now', async function () {
            const before = Date.now();
            const {exp} = await sso.mintToken({userId: 'u1', targetSiteId: 's1'});
            assert.ok(
                exp >= before + 59_000 && exp <= before + 61_000,
                `expected exp within 60s window, got ${exp - before}ms`
            );
        });
    });

    describe('replay defence', function () {
        it('refuses a second redeem of the same token', async function () {
            const {token} = await sso.mintToken({userId: 'u1', targetSiteId: 's1'});
            await sso.verifyAndConsumeToken({token});
            await assert.rejects(
                sso.verifyAndConsumeToken({token}),
                /already used/
            );
        });
    });

    describe('signature failure', function () {
        it('rejects token signed with a different secret', async function () {
            // Craft a well-formed token but signed with 'wrong-secret'.
            // verifyAndConsumeToken will use 'unit-test-secret' (from stub)
            // and reject the mismatched MAC.
            const token = sso.__sign(
                {userId: 'u1', targetSiteId: 's1', exp: Date.now() + 60_000, nonce: 'n-bad'},
                'wrong-secret'
            );
            await assert.rejects(
                sso.verifyAndConsumeToken({token}),
                /Invalid SSO token/
            );
        });

        it('rejects a structurally-broken token', async function () {
            await assert.rejects(
                sso.verifyAndConsumeToken({token: 'not-a-real-token'}),
                /Invalid SSO token/
            );
        });
    });

    describe('expiration', function () {
        it('rejects an already-expired token', async function () {
            // Sign with the same secret the verifier will use — only exp differs.
            const expired = {userId: 'u1', targetSiteId: 's1', exp: Date.now() - 10_000, nonce: 'n1'};
            const token = sso.__sign(expired, 'unit-test-secret');
            await assert.rejects(
                sso.verifyAndConsumeToken({token}),
                /expired/
            );
        });
    });

    describe('findOrCreateMirrorUser', function () {
        it('rejects non-superadmin source users', async function () {
            const knex = makeFakeKnex({
                users: [{id: 'u1', email: 'a@b.test', is_superadmin: false}]
            });
            await assert.rejects(
                sso.findOrCreateMirrorUser({knex, sourceUserId: 'u1', targetSiteId: 's1'}),
                /superadmin/
            );
        });

        it('returns existing mirror user when email already present on target site', async function () {
            const sourceRow = {id: 'src', email: 'admin@test', name: 'Admin', is_superadmin: true};
            const mirrorRow = {id: 'mirror-id', email: 'admin@test'};
            // Two queries hit 'users': first fetches source-by-id, second finds mirror-by-email.
            let usersCallCount = 0;
            const knex = (table) => {
                if (table === 'users') {
                    usersCallCount++;
                    const row = usersCallCount === 1 ? sourceRow : mirrorRow;
                    return {
                        where: sinon.stub().returnsThis(),
                        andWhere: sinon.stub().returnsThis(),
                        first: () => Promise.resolve(row)
                    };
                }
                return {
                    where: sinon.stub().returnsThis(),
                    andWhere: sinon.stub().returnsThis(),
                    first: () => Promise.resolve(null)
                };
            };
            knex.transaction = async (fn) => fn(knex);

            const {userId, created} = await sso.findOrCreateMirrorUser({
                knex, sourceUserId: 'src', targetSiteId: 'tgt'
            });
            assert.equal(userId, 'mirror-id');
            assert.equal(created, false);
        });
    });
});
