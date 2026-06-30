#!/usr/bin/env node
//
// TownBrief multitenancy Phase 9b + 9c: command-line site provisioner.
//
//   docker exec ghost-dev node scripts/townbrief-add-site.js \
//       --slug=wayland --name="The Wayland Post" --host=wayland.townbrief.com \
//       [--custom-domain=waylandpost.org] [--owner-email=editor@example.com]
//
// Bypasses HTTP auth; talks straight to Postgres. Creates the `sites`
// row, seeds 118 default settings, clones roles+permissions+permissions_roles
// from the default site (Phase 9c), and (if --owner-email points at an
// existing superadmin user) provisions them as the Owner of the new
// site so they can log in to its admin URL with the same credentials.
//
// Idempotent on host collision: errors out cleanly if slug/host
// already exists, never partially creates.

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

// Resolve ghost/core for BOTH layouts: dev bind-mounts the source repo (ghost/core
// at /home/ghost/ghost/core), while the packed PRODUCTION image IS ghost/core mounted
// at /home/ghost (no nested ghost/core). Detect by the markers this script needs.
function resolveGhostCore() {
    const candidates = [
        process.env.GHOST_CORE_DIR,
        '/home/ghost/ghost/core', // dev: bind-mounted source
        '/home/ghost'             // prod: packed standalone (ghost/core is the app root)
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(path.join(c, 'node_modules', 'knex')) &&
                fs.existsSync(path.join(c, 'core', 'shared', 'config'))) {
                return c;
            }
        } catch (e) { /* try next candidate */ }
    }
    throw new Error('townbrief-add-site: could not locate ghost/core (set GHOST_CORE_DIR)');
}
const ghostCore = resolveGhostCore();
process.chdir(ghostCore);
const knex = require(path.join(ghostCore, 'node_modules/knex'));

function arg(name) {
    const found = process.argv.find(a => a.startsWith(`--${name}=`));
    if (!found) return undefined;
    return found.slice(name.length + 3);
}

async function main() {
    const slug = arg('slug');
    const name = arg('name');
    const host = arg('host');
    const customDomain = arg('custom-domain') || null;
    const ownerEmail = arg('owner-email') || null;

    if (!slug || !name || !host) {
        console.error('Usage: townbrief-add-site.js --slug=<slug> --name="<name>" --host=<host> [--custom-domain=<domain>]');
        process.exit(2);
    }

    // Resolve DB config from Ghost's own config layer so this script
    // works in any env where Ghost itself works.
    const dbConfig = require(path.join(ghostCore, 'core/shared/config')).get('database');
    const k = knex(dbConfig);

    try {
        const existingHost = await k('sites').where('host', host).orWhere('custom_domain', host).first('id');
        if (existingHost) throw new Error(`A site with host "${host}" already exists`);
        const existingSlug = await k('sites').where('slug', slug).first('id');
        if (existingSlug) throw new Error(`A site with slug "${slug}" already exists`);

        const ObjectID = require(path.join(ghostCore, 'node_modules/bson-objectid')).default;
        const defaultSettings = require(path.join(ghostCore, 'core/server/data/schema/default-settings'));
        const {seedRolesAndPermissionsForSite, provisionOwnerUserForSite} =
            require(path.join(ghostCore, 'core/server/services/multitenancy/site-seeders'));

        const siteId = (new ObjectID()).toHexString();
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Look up the owner-email superadmin BEFORE the transaction so
        // we fail fast with a clear error if --owner-email is set but
        // points at no user (or a non-superadmin).
        let ownerSourceUser = null;
        if (ownerEmail) {
            ownerSourceUser = await k('users')
                .where('email', ownerEmail).where('is_superadmin', true).first();
            if (!ownerSourceUser) {
                throw new Error(`No superadmin user found with email "${ownerEmail}" — promote them with UPDATE users SET is_superadmin=true WHERE email=... first.`);
            }
        }

        let seedSummary = {rolesSeeded: 0, permissionsSeeded: 0, relationsSeeded: 0, ownerRoleId: null};
        let ownerUserId = null;

        await k.transaction(async (trx) => {
            await trx('sites').insert({
                id: siteId, slug, name, host, custom_domain: customDomain,
                status: 'active', stripe_account_id: null, mailgun_from: null,
                created_at: now, updated_at: now
            });

            const rows = [];
            for (const groupName of Object.keys(defaultSettings)) {
                const group = defaultSettings[groupName];
                for (const key of Object.keys(group)) {
                    const def = group[key];
                    let value = def.defaultValue;
                    // site_uuid is the analytics-isolation key for Tinybird and
                    // MUST be unique per site. default-settings.json defaults it
                    // to null, and the boot-time fallback reuses one cached UUID
                    // across sites — so mint a fresh one here at provision time.
                    if (key === 'site_uuid') {
                        value = crypto.randomUUID();
                    }
                    if (value === undefined) value = null;
                    if (value !== null && typeof value === 'object') value = JSON.stringify(value);
                    else if (value !== null) value = String(value);
                    rows.push({
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
            await trx.batchInsert('settings', rows, 100);

            // Phase 9c: clone the default site's auth model.
            seedSummary = await seedRolesAndPermissionsForSite(trx, siteId);
            // Optional owner user provisioning when --owner-email matched.
            ownerUserId = await provisionOwnerUserForSite(trx, ownerSourceUser, siteId, seedSummary.ownerRoleId);
        });

        console.log(JSON.stringify({
            ok: true,
            site: {id: siteId, slug, name, host, custom_domain: customDomain, status: 'active'},
            settings_seeded: 118,
            roles_seeded: seedSummary.rolesSeeded,
            permissions_seeded: seedSummary.permissionsSeeded,
            permissions_roles_seeded: seedSummary.relationsSeeded,
            owner_user_id: ownerUserId
        }, null, 2));
    } catch (err) {
        console.error('ERR:', err.message);
        process.exit(1);
    } finally {
        await k.destroy();
    }
}

main();
