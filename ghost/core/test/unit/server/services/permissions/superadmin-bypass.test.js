const assert = require('node:assert/strict');
const sinon = require('sinon');
const path = require('path');

// Phase 5d.1 unit test: providers.user() returns a synthetic Owner role
// for any user with `is_superadmin: true`, so the canThis bypass fires
// without needing the explicit permissions_roles linkage.

// Stub the models BEFORE requiring the provider.
const modelsPath = path.join(__dirname, '../../../../../core/server/models');

describe('UNIT: permissions providers.user (Phase 5d.1 superadmin bypass)', function () {
    let providers;
    let UserFindOneStub;

    beforeEach(function () {
        UserFindOneStub = sinon.stub();
        const fakeModels = {
            User: {findOne: UserFindOneStub}
        };
        // Clear require cache + inject stub for the providers module.
        const providersPath = require.resolve('../../../../../core/server/services/permissions/providers.js');
        delete require.cache[providersPath];
        delete require.cache[require.resolve(modelsPath)];
        require.cache[require.resolve(modelsPath)] = {
            id: modelsPath,
            filename: modelsPath,
            loaded: true,
            exports: fakeModels
        };
        providers = require('../../../../../core/server/services/permissions/providers.js');
    });

    afterEach(function () {
        sinon.restore();
        // Reset module cache so other tests get the real models.
        delete require.cache[require.resolve(modelsPath)];
        delete require.cache[require.resolve('../../../../../core/server/services/permissions/providers.js')];
    });

    function fakeUser({id = 'u1', email = 'a@b.test', status = 'active', isSuperadmin = false, roles = [], permissions = []}) {
        const data = {id, email, status, is_superadmin: isSuperadmin, roles};
        return {
            get(key) { return data[key]; },
            related(key) {
                if (key === 'roles') return {models: roles.map(r => ({related: () => ({models: []}), get: (k) => r[k]}))};
                if (key === 'permissions') return {models: permissions};
                return null;
            },
            toJSON() { return data; }
        };
    }

    it('returns a synthetic Owner role when is_superadmin=true', async function () {
        UserFindOneStub.resolves(fakeUser({isSuperadmin: true, roles: []}));
        const result = await providers.user('any-id');
        assert.ok(Array.isArray(result.roles), 'roles is array');
        assert.equal(result.roles.length, 1, 'exactly one synthetic role');
        assert.equal(result.roles[0].name, 'Owner', 'synthetic role is named Owner');
        assert.deepEqual(result.permissions, [], 'no explicit perms needed — bypass via role');
    });

    it('still rejects when user not found', async function () {
        UserFindOneStub.resolves(null);
        await assert.rejects(providers.user('ghost-id'), /User not found/);
    });

    it('still rejects inactive users (even superadmins)', async function () {
        UserFindOneStub.resolves(fakeUser({isSuperadmin: true, status: 'inactive'}));
        await assert.rejects(providers.user('inactive-su'));
    });

    it('falls through to normal perm loading for non-superadmin users', async function () {
        const adminRole = {id: 'r-admin', name: 'Administrator'};
        const fakeUserObj = fakeUser({
            isSuperadmin: false,
            roles: [adminRole]
        });
        UserFindOneStub.resolves(fakeUserObj);
        const result = await providers.user('regular-user');
        // For non-superadmin we go through the original branch — roles come
        // from the user's actual relations (parsed from toJSON output).
        assert.deepEqual(result.roles, [adminRole], 'roles from user.toJSON, not synthetic');
    });
});
