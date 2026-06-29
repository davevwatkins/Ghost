// TownBrief multitenancy Phase 9c: shared helpers for seeding a new
// site with the canonical roles + permissions + role-permission
// mapping, plus optionally provisioning an Owner user. Used by both
// the admin API endpoint (`api/endpoints/sites.js`) and the CLI
// provisioner (`scripts/townbrief-add-site.js`).
//
// All three tables (roles, permissions, permissions_roles) carry
// site_id (Phase 2), so cloning from an existing site (typically the
// default) with the new site_id makes the new site authoritative for
// its own auth model. Old→new id maps are returned so the join table
// is cloned with correct FKs.
//
// These functions take an explicit `trx` (Knex transaction) so the
// whole add-site flow stays atomic. They use raw knex — bypassing the
// Phase 3 Bookshelf plugin — because we need to read from the source
// site (often different from whatever the active site is) and write
// to the new site without filtering.

const ObjectID = require('bson-objectid').default;

const DEFAULT_SOURCE_SITE_ID = 'default0000000000000000';

async function seedRolesAndPermissionsForSite(trx, newSiteId, sourceSiteId = DEFAULT_SOURCE_SITE_ID) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // 1. Clone roles. Map old id -> new id.
    const sourceRoles = await trx('roles').where('site_id', sourceSiteId).select('*');
    const roleIdMap = new Map();
    const newRoles = sourceRoles.map(r => {
        const newId = (new ObjectID()).toHexString();
        roleIdMap.set(r.id, newId);
        return {
            ...r,
            id: newId,
            site_id: newSiteId,
            created_at: now,
            updated_at: now
        };
    });
    if (newRoles.length) await trx.batchInsert('roles', newRoles, 100);

    // 2. Clone permissions. Map old id -> new id.
    const sourcePermissions = await trx('permissions').where('site_id', sourceSiteId).select('*');
    const permissionIdMap = new Map();
    const newPermissions = sourcePermissions.map(p => {
        const newId = (new ObjectID()).toHexString();
        permissionIdMap.set(p.id, newId);
        return {
            ...p,
            id: newId,
            site_id: newSiteId,
            created_at: now,
            updated_at: now
        };
    });
    if (newPermissions.length) await trx.batchInsert('permissions', newPermissions, 100);

    // 3. Clone permissions_roles using both id maps.
    const sourceRelations = await trx('permissions_roles').where('site_id', sourceSiteId).select('*');
    const newRelations = sourceRelations
        .filter(rel => roleIdMap.has(rel.role_id) && permissionIdMap.has(rel.permission_id))
        .map(rel => ({
            id: (new ObjectID()).toHexString(),
            site_id: newSiteId,
            role_id: roleIdMap.get(rel.role_id),
            permission_id: permissionIdMap.get(rel.permission_id)
        }));
    if (newRelations.length) await trx.batchInsert('permissions_roles', newRelations, 100);

    const ownerEntry = sourceRoles.find(r => r.name === 'Owner');
    return {
        rolesSeeded: newRoles.length,
        permissionsSeeded: newPermissions.length,
        relationsSeeded: newRelations.length,
        ownerRoleId: ownerEntry ? roleIdMap.get(ownerEntry.id) : null,
        roleIdMap,
        permissionIdMap
    };
}

async function provisionOwnerUserForSite(trx, sourceSuperadmin, newSiteId, ownerRoleId) {
    if (!sourceSuperadmin || !ownerRoleId) return null;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const newUserId = (new ObjectID()).toHexString();
    const newUser = {
        ...sourceSuperadmin,
        id: newUserId,
        site_id: newSiteId,
        is_superadmin: true,
        // Copy the existing password hash so the same credential works
        // until SHARED-IDENTITY (cross-site SSO) ships.
        password: sourceSuperadmin.password,
        created_at: now,
        updated_at: now,
        last_seen: null
    };
    await trx('users').insert(newUser);
    await trx('roles_users').insert({
        id: (new ObjectID()).toHexString(),
        site_id: newSiteId,
        user_id: newUserId,
        role_id: ownerRoleId
    });
    return newUserId;
}

module.exports = {
    seedRolesAndPermissionsForSite,
    provisionOwnerUserForSite,
    DEFAULT_SOURCE_SITE_ID
};
