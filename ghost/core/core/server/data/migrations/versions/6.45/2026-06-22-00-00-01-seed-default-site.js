const {createTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');
const ObjectID = require('bson-objectid').default;

// TownBrief multitenancy phase 1: seed a `default` site row so that any
// existing single-tenant data backfilled with site_id='default' (Phase 2)
// has a valid FK target, and so that fresh installs have a site to point
// localhost / catch-all hostnames at during dev.
//
// Idempotent: if a `default` site already exists, this is a no-op.
module.exports = createTransactionalMigration(
    async function up(knex) {
        const existing = await knex('sites').where('slug', 'default').first();
        if (existing) {
            logging.warn('sites.default already exists, skipping seed');
            return;
        }

        const now = knex.fn.now();
        await knex('sites').insert({
            id: (new ObjectID()).toHexString(),
            slug: 'default',
            name: 'Default Site',
            // The catch-all host. In production this row should be replaced
            // (or its host updated) by the first `add-site` provisioning
            // step for the real first tenant.
            host: 'localhost',
            custom_domain: null,
            status: 'active',
            stripe_account_id: null,
            mailgun_from: null,
            created_at: now,
            updated_at: now
        });

        logging.info('Seeded sites.default (host=localhost)');
    },
    async function down(knex) {
        logging.info('Removing sites.default');
        await knex('sites').where('slug', 'default').del();
    }
);
