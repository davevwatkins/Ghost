const crypto = require('crypto');
const db = require('../../data/db');
const models = require('../../models');
const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const ObjectID = require('bson-objectid').default;
const defaultSettings = require('../../data/schema/default-settings');
const {seedRolesAndPermissionsForSite, provisionOwnerUserForSite} = require('../../services/multitenancy/site-seeders');

// TownBrief multitenancy Phase 5a + 9: admin API for sites.
// - `browse` (5a): site picker — list the sites the current user can switch to.
// - `add` (9): create a new site. Superadmin only. Seeds the new
//   site's default settings from default-settings.json so the site is
//   immediately usable (admin can log in via the new host, edit posts,
//   etc.). Owner-user creation is Phase 9b.
//
// We hit the `sites` table directly rather than via a Bookshelf model
// (no Site model yet — deferred refactor). That also means the Phase 3
// auto-scoping plugin doesn't fire, which is what we want for cross-
// site lookups and provisioning.

const messages = {
    forbidden: 'Only a superadmin user can create sites.',
    missingField: 'Missing required field: {field}',
    duplicateHost: 'A site with host "{host}" already exists.',
    duplicateSlug: 'A site with slug "{slug}" already exists.'
};

// Default settings.json is keyed by group -> { key: {defaultValue, type, flags, ...} }.
// Flatten into rows suitable for INSERT INTO settings.
function defaultSettingsRowsFor(siteId) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const rows = [];
    for (const groupName of Object.keys(defaultSettings)) {
        const group = defaultSettings[groupName];
        for (const key of Object.keys(group)) {
            const def = group[key];
            const type = def.type || 'string';
            let value = def.defaultValue;
            // site_uuid is the per-site analytics-isolation key for Tinybird
            // and MUST be unique per site. default-settings.json defaults it to
            // null and the boot-time fallback reuses one cached UUID across
            // sites, so mint a fresh one here at provision time (matches
            // scripts/townbrief-add-site.js).
            if (key === 'site_uuid') {
                value = crypto.randomUUID();
            }
            if (value === undefined) value = null;
            // Stringify object/array defaults the same way Ghost's fixture
            // manager does — settings are stored as text.
            if (value !== null && typeof value === 'object') {
                value = JSON.stringify(value);
            } else if (value !== null) {
                value = String(value);
            }
            rows.push({
                id: (new ObjectID()).toHexString(),
                site_id: siteId,
                group: groupName,
                key,
                value,
                type,
                flags: def.flags || null,
                created_at: now,
                updated_at: now
            });
        }
    }
    return rows;
}

/** @type {import('@tryghost/api-framework').Controller} */
const controller = {
    docName: 'sites',

    browse: {
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        async query(frame) {
            const ctx = frame.options.context || {};
            const userId = ctx.user;

            let user = null;
            if (userId) {
                user = await models.User.findOne(
                    {id: userId},
                    {context: {internal: true, allowCrossSite: true}}
                );
            }

            const isSuperadmin = !!(user && user.get('is_superadmin'));

            let rows;
            if (isSuperadmin) {
                rows = await db.knex('sites')
                    .where('status', 'active')
                    .orderBy('name')
                    .select('id', 'slug', 'name', 'host', 'custom_domain', 'status');
            } else if (user) {
                rows = await db.knex('sites')
                    .where('id', user.get('site_id'))
                    .andWhere('status', 'active')
                    .select('id', 'slug', 'name', 'host', 'custom_domain', 'status');
            } else {
                rows = [];
            }

            return {
                sites: rows,
                meta: {
                    is_superadmin: isSuperadmin
                }
            };
        }
    },

    add: {
        statusCode: 201,
        headers: {
            cacheInvalidate: false
        },
        permissions: false,
        async query(frame) {
            const ctx = frame.options.context || {};
            const userId = ctx.user;

            // Only an authenticated superadmin can create sites.
            const user = userId && await models.User.findOne(
                {id: userId},
                {context: {internal: true, allowCrossSite: true}}
            );
            if (!user || !user.get('is_superadmin')) {
                throw new errors.NoPermissionError({
                    message: tpl(messages.forbidden)
                });
            }

            const input = (frame.data && frame.data.sites && frame.data.sites[0]) || {};
            const slug = input.slug && String(input.slug).trim().toLowerCase();
            const name = input.name && String(input.name).trim();
            const host = input.host && String(input.host).trim().toLowerCase();
            const customDomain = input.custom_domain ? String(input.custom_domain).trim().toLowerCase() : null;

            if (!slug) throw new errors.ValidationError({message: tpl(messages.missingField, {field: 'slug'})});
            if (!name) throw new errors.ValidationError({message: tpl(messages.missingField, {field: 'name'})});
            if (!host) throw new errors.ValidationError({message: tpl(messages.missingField, {field: 'host'})});

            // Uniqueness pre-checks. Postgres would reject these anyway,
            // but a clean 422 with a clear message is friendlier than the
            // raw constraint-violation error.
            const existingHost = await db.knex('sites').where('host', host).orWhere('custom_domain', host).first('id');
            if (existingHost) {
                throw new errors.ValidationError({message: tpl(messages.duplicateHost, {host})});
            }
            const existingSlug = await db.knex('sites').where('slug', slug).first('id');
            if (existingSlug) {
                throw new errors.ValidationError({message: tpl(messages.duplicateSlug, {slug})});
            }

            const siteId = (new ObjectID()).toHexString();
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const DEFAULT_SITE_ID = 'default0000000000000000';

            // Pull the calling superadmin's full row so Phase 9c can
            // provision them as the Owner of the new site.
            const callingUserRow = await db.knex('users')
                .where('id', userId).first();

            let seedSummary = {rolesSeeded: 0, permissionsSeeded: 0, relationsSeeded: 0, ownerRoleId: null};
            let ownerUserId = null;

            await db.knex.transaction(async (trx) => {
                await trx('sites').insert({
                    id: siteId,
                    slug,
                    name,
                    host,
                    custom_domain: customDomain,
                    status: 'active',
                    stripe_account_id: null,
                    mailgun_from: null,
                    created_at: now,
                    updated_at: now
                });

                // Seed default settings for the new site.
                const rows = defaultSettingsRowsFor(siteId);
                await trx.batchInsert('settings', rows, 100);

                // Phase 9c: clone the default site's roles/permissions/
                // permissions_roles into the new site, then provision the
                // calling superadmin as Owner.
                seedSummary = await seedRolesAndPermissionsForSite(trx, siteId, DEFAULT_SITE_ID);
                ownerUserId = await provisionOwnerUserForSite(trx, callingUserRow, siteId, seedSummary.ownerRoleId);
            });

            return {
                sites: [{
                    id: siteId, slug, name, host,
                    custom_domain: customDomain,
                    status: 'active'
                }],
                meta: {
                    settings_seeded: 118,
                    roles_seeded: seedSummary.rolesSeeded,
                    permissions_seeded: seedSummary.permissionsSeeded,
                    permissions_roles_seeded: seedSummary.relationsSeeded,
                    owner_user_id: ownerUserId
                }
            };
        }
    }
};

module.exports = controller;
