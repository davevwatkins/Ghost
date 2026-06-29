const assert = require('node:assert/strict');
const sinon = require('sinon');

// Phase 5d.2 unit test: the session.delete() controller fans out the
// signout to delete all sessions for the superadmin across every site
// where they have a mirror user (joined by email). Non-superadmins
// hit only the local-logout path.

describe('UNIT: session.delete propagation (Phase 5d.2 signout fan-out)', function () {
    let sessionEndpoint;
    let authLogoutStub;
    let dbKnexStub;
    let runWithoutSiteStub;

    beforeEach(function () {
        authLogoutStub = sinon.stub().callsArg(2); // next()

        // session.js line 3 requires ../../models, which transitively
        // loads models/base/bookshelf.js, which calls new Bookshelf(db.knex).
        // We stub models before requiring session.js so Bookshelf is never
        // initialised with our fake (non-knex) db stub.
        const modelsPath = require.resolve('../../../../../core/server/models');
        delete require.cache[modelsPath];
        require.cache[modelsPath] = {
            id: modelsPath, filename: modelsPath, loaded: true,
            exports: {} // session.delete() doesn't use models
        };

        // Stub auth.session.logout via require cache.
        const authPath = require.resolve('../../../../../core/server/services/auth');
        delete require.cache[authPath];
        require.cache[authPath] = {
            id: authPath, filename: authPath, loaded: true,
            exports: {session: {logout: authLogoutStub}}
        };

        // Stub db.knex. dbKnexStub is set per-test in runDeleteWith.
        const dbPath = require.resolve('../../../../../core/server/data/db');
        delete require.cache[dbPath];
        require.cache[dbPath] = {
            id: dbPath, filename: dbPath, loaded: true,
            exports: {get knex() { return dbKnexStub; }}
        };

        // Stub multitenancy/current-site.runWithoutSite.
        const csPath = require.resolve('../../../../../core/server/services/multitenancy/current-site');
        delete require.cache[csPath];
        runWithoutSiteStub = sinon.stub().callsFake(async (fn) => fn());
        require.cache[csPath] = {
            id: csPath, filename: csPath, loaded: true,
            exports: {runWithoutSite: runWithoutSiteStub}
        };

        const endpointPath = require.resolve('../../../../../core/server/api/endpoints/session.js');
        delete require.cache[endpointPath];
        sessionEndpoint = require('../../../../../core/server/api/endpoints/session.js');
    });

    afterEach(function () {
        sinon.restore();
        delete require.cache[require.resolve('../../../../../core/server/models')];
        delete require.cache[require.resolve('../../../../../core/server/services/auth')];
        delete require.cache[require.resolve('../../../../../core/server/data/db')];
        delete require.cache[require.resolve('../../../../../core/server/services/multitenancy/current-site')];
        delete require.cache[require.resolve('../../../../../core/server/api/endpoints/session.js')];
    });

    async function runDeleteWith({sessionUserId, knexUsers, knexSessionsDel}) {
        // Wire dbKnexStub
        const userWhere = sinon.stub();
        userWhere.returnsThis();
        const firstStub = sinon.stub();
        // Two queries are made: users.where(id).first(...) and users.where(email).select('id')
        // We'll route by table name.
        const queries = {
            users: () => ({
                where: sinon.stub().callsFake((col, val) => {
                    return {
                        first: () => Promise.resolve(knexUsers.first(col, val)),
                        select: () => Promise.resolve(knexUsers.select(col, val))
                    };
                })
            }),
            sessions: () => ({
                whereIn: sinon.stub().returns({
                    del: () => Promise.resolve(knexSessionsDel())
                })
            })
        };
        dbKnexStub = (tbl) => queries[tbl]();

        // Re-inject db so it reads the new dbKnexStub.
        const dbPath = require.resolve('../../../../../core/server/data/db');
        require.cache[dbPath].exports = {get knex() { return dbKnexStub; }};

        // Build the mw and invoke it
        const mw = await sessionEndpoint.delete();
        const req = {session: {user_id: sessionUserId}};
        const res = {};
        await new Promise((resolve) => mw(req, res, resolve));
    }

    it('superadmin signout: deletes sessions across all matching emails', async function () {
        const sessionsDel = sinon.stub().resolves(7);
        await runDeleteWith({
            sessionUserId: 'su-default',
            knexUsers: {
                first: (col, val) => (col === 'id' && val === 'su-default')
                    ? {email: 'dave@example.test', is_superadmin: true}
                    : null,
                select: (col, val) => (col === 'email' && val === 'dave@example.test')
                    ? [{id: 'su-default'}, {id: 'mirror-wayland'}, {id: 'mirror-concord'}, {id: 'mirror-lex'}]
                    : []
            },
            knexSessionsDel: () => sessionsDel()
        });
        sinon.assert.calledOnce(sessionsDel);
        sinon.assert.calledOnce(runWithoutSiteStub);
        sinon.assert.calledOnce(authLogoutStub);
    });

    it('non-superadmin signout: does NOT fan out', async function () {
        const sessionsDel = sinon.stub().resolves(0);
        await runDeleteWith({
            sessionUserId: 'regular-u',
            knexUsers: {
                first: () => ({email: 'bob@example.test', is_superadmin: false}),
                select: () => [{id: 'regular-u'}]
            },
            knexSessionsDel: () => sessionsDel()
        });
        sinon.assert.notCalled(sessionsDel);
        sinon.assert.calledOnce(authLogoutStub); // local logout still runs
    });

    it('lookup error: still proceeds to local logout (best-effort)', async function () {
        const sessionsDel = sinon.stub().resolves(0);
        // Force runWithoutSite to throw — should be swallowed.
        runWithoutSiteStub.callsFake(() => { throw new Error('db down'); });
        await runDeleteWith({
            sessionUserId: 'su-default',
            knexUsers: {first: () => null, select: () => []},
            knexSessionsDel: () => sessionsDel()
        });
        sinon.assert.calledOnce(authLogoutStub); // local logout always runs
    });

    it('no session.user_id (already logged out): skips fan-out, still calls local logout', async function () {
        const sessionsDel = sinon.stub().resolves(0);
        await runDeleteWith({
            sessionUserId: undefined,
            knexUsers: {first: () => null, select: () => []},
            knexSessionsDel: () => sessionsDel()
        });
        sinon.assert.notCalled(runWithoutSiteStub);
        sinon.assert.calledOnce(authLogoutStub);
    });
});
