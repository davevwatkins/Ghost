const assert = require('node:assert/strict');
const sinon = require('sinon');

const {
    seedRolesAndPermissionsForSite,
    provisionOwnerUserForSite,
    DEFAULT_SOURCE_SITE_ID
} = require('../../../../../core/server/services/multitenancy/site-seeders');

// Phase 9c: clone the default site's roles + permissions +
// permissions_roles into a new site. Also provision an Owner user when
// a source superadmin is supplied.

const NEW_SITE = 'newsite0000000000000000a';
const SRC_SITE = DEFAULT_SOURCE_SITE_ID;

// Build a minimal in-memory trx stub backed by a per-table data map.
// Calls flow as `trx('roles').where(...).select(...)` and
// `trx.batchInsert(table, rows, batchSize)`. Tracks every batchInsert
// payload so tests can assert on what was inserted.
function mkTrxStub({rolesAtSrc = [], permissionsAtSrc = [], relationsAtSrc = []} = {}) {
    const inserted = {roles: [], permissions: [], permissions_roles: [], users: [], roles_users: []};
    const tableData = {
        roles: rolesAtSrc,
        permissions: permissionsAtSrc,
        permissions_roles: relationsAtSrc
    };
    function tbl(name) {
        return {
            where(col, val) {
                this._filter = {[col]: val};
                return this;
            },
            select() {
                const rows = tableData[name] || [];
                if (this._filter && this._filter.site_id) {
                    return Promise.resolve(rows.filter(r => r.site_id === this._filter.site_id));
                }
                return Promise.resolve(rows);
            },
            insert(row) {
                inserted[name].push(row);
                return Promise.resolve([1]);
            }
        };
    }
    const trx = (name) => tbl(name);
    trx.batchInsert = (name, rows) => {
        for (const r of rows) inserted[name].push(r);
        return Promise.resolve(rows.length);
    };
    trx._inserted = inserted;
    return trx;
}

describe('UNIT: site-seeders (Phase 9c)', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('seedRolesAndPermissionsForSite', function () {
        it('clones roles, permissions, and relations with new ids + new site_id', async function () {
            const trx = mkTrxStub({
                rolesAtSrc: [
                    {id: 'r1', site_id: SRC_SITE, name: 'Owner', description: 'Site owner'},
                    {id: 'r2', site_id: SRC_SITE, name: 'Administrator', description: 'Admins'},
                    {id: 'r3', site_id: SRC_SITE, name: 'Editor', description: 'Editors'}
                ],
                permissionsAtSrc: [
                    {id: 'p1', site_id: SRC_SITE, name: 'browse posts', action_type: 'browse', object_type: 'post'},
                    {id: 'p2', site_id: SRC_SITE, name: 'edit settings', action_type: 'edit', object_type: 'setting'}
                ],
                relationsAtSrc: [
                    {id: 'rp1', site_id: SRC_SITE, role_id: 'r1', permission_id: 'p1'},
                    {id: 'rp2', site_id: SRC_SITE, role_id: 'r1', permission_id: 'p2'},
                    {id: 'rp3', site_id: SRC_SITE, role_id: 'r2', permission_id: 'p1'}
                ]
            });

            const result = await seedRolesAndPermissionsForSite(trx, NEW_SITE);

            assert.equal(result.rolesSeeded, 3);
            assert.equal(result.permissionsSeeded, 2);
            assert.equal(result.relationsSeeded, 3);
            assert.ok(result.ownerRoleId, 'must surface the new Owner role id');

            // Every inserted row has the new site_id and a fresh id.
            for (const r of trx._inserted.roles) {
                assert.equal(r.site_id, NEW_SITE);
                assert.notEqual(r.id, 'r1');
                assert.notEqual(r.id, 'r2');
                assert.notEqual(r.id, 'r3');
            }
            for (const p of trx._inserted.permissions) {
                assert.equal(p.site_id, NEW_SITE);
            }
            // Relations map to the new ids, not the old.
            for (const rel of trx._inserted.permissions_roles) {
                assert.equal(rel.site_id, NEW_SITE);
                const inserted_role_ids = trx._inserted.roles.map(r => r.id);
                const inserted_perm_ids = trx._inserted.permissions.map(p => p.id);
                assert.ok(inserted_role_ids.includes(rel.role_id),
                    `relation role_id ${rel.role_id} must reference a freshly-inserted role`);
                assert.ok(inserted_perm_ids.includes(rel.permission_id),
                    `relation permission_id ${rel.permission_id} must reference a freshly-inserted permission`);
            }
        });

        it('skips relations whose endpoints are missing from the source', async function () {
            const trx = mkTrxStub({
                rolesAtSrc: [{id: 'r1', site_id: SRC_SITE, name: 'Owner'}],
                permissionsAtSrc: [{id: 'p1', site_id: SRC_SITE, name: 'browse'}],
                relationsAtSrc: [
                    {id: 'rp_good', site_id: SRC_SITE, role_id: 'r1', permission_id: 'p1'},
                    {id: 'rp_orphan_role', site_id: SRC_SITE, role_id: 'r_missing', permission_id: 'p1'},
                    {id: 'rp_orphan_perm', site_id: SRC_SITE, role_id: 'r1', permission_id: 'p_missing'}
                ]
            });
            const result = await seedRolesAndPermissionsForSite(trx, NEW_SITE);
            assert.equal(result.relationsSeeded, 1, 'orphan relations are dropped');
        });

        it('returns ownerRoleId=null when there is no Owner role in the source', async function () {
            const trx = mkTrxStub({
                rolesAtSrc: [{id: 'r1', site_id: SRC_SITE, name: 'Editor'}]
            });
            const result = await seedRolesAndPermissionsForSite(trx, NEW_SITE);
            assert.equal(result.ownerRoleId, null);
        });

        it('handles an empty source (returns all-zero counts cleanly)', async function () {
            const trx = mkTrxStub({});
            const result = await seedRolesAndPermissionsForSite(trx, NEW_SITE);
            assert.deepEqual(
                {r: result.rolesSeeded, p: result.permissionsSeeded, rp: result.relationsSeeded, owner: result.ownerRoleId},
                {r: 0, p: 0, rp: 0, owner: null}
            );
        });
    });

    describe('provisionOwnerUserForSite', function () {
        it('inserts a users row + roles_users mapping when both inputs are present', async function () {
            const trx = mkTrxStub({});
            const sourceSuperadmin = {
                id: 'oldUser000000000000000aa',
                site_id: 'someothersite',
                name: 'Editor Editorson',
                email: 'editor@example.com',
                password: '$2a$hash',
                is_superadmin: true
            };
            const ownerRoleId = 'newOwnerRoleId00000000a';
            const newUserId = await provisionOwnerUserForSite(trx, sourceSuperadmin, NEW_SITE, ownerRoleId);
            assert.ok(newUserId, 'new user id returned');
            assert.equal(trx._inserted.users.length, 1);
            const u = trx._inserted.users[0];
            assert.equal(u.site_id, NEW_SITE);
            assert.notEqual(u.id, sourceSuperadmin.id);
            assert.equal(u.email, sourceSuperadmin.email);
            assert.equal(u.password, sourceSuperadmin.password,
                'password hash is copied verbatim until SHARED-IDENTITY ships');
            assert.equal(u.is_superadmin, true);
            assert.equal(u.last_seen, null);

            assert.equal(trx._inserted.roles_users.length, 1);
            const ru = trx._inserted.roles_users[0];
            assert.equal(ru.site_id, NEW_SITE);
            assert.equal(ru.user_id, newUserId);
            assert.equal(ru.role_id, ownerRoleId);
        });

        it('returns null and inserts nothing when sourceSuperadmin is missing', async function () {
            const trx = mkTrxStub({});
            const out = await provisionOwnerUserForSite(trx, null, NEW_SITE, 'ownerRole0000000000000aa');
            assert.equal(out, null);
            assert.equal(trx._inserted.users.length, 0);
            assert.equal(trx._inserted.roles_users.length, 0);
        });

        it('returns null and inserts nothing when ownerRoleId is missing', async function () {
            const trx = mkTrxStub({});
            const out = await provisionOwnerUserForSite(trx, {id: 'x', email: 'x@y.z', password: 'h'}, NEW_SITE, null);
            assert.equal(out, null);
            assert.equal(trx._inserted.users.length, 0);
            assert.equal(trx._inserted.roles_users.length, 0);
        });
    });
});
