const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy phase 1.5: install the `current_site_id()` SQL
// helper used by Phase 2's RLS policies. It returns the current request's
// site_id, sourced from the Postgres GUC `app.site_id` that the
// host-resolver middleware sets per-request via `SET LOCAL` (Phase 1.5b,
// pending). The `, true` flag on current_setting makes it return null
// when the GUC is unset (background jobs, migrations, superadmin tooling)
// rather than raising an error. RLS policies then treat null as "no
// active site" and either block (deny-by-default) or allow (for superadmin
// contexts that explicitly opt in).
//
// Postgres-only migration — knex-migrator's init path will skip this on
// fresh installs but that's fine because this is a one-shot function
// definition, not a per-tenant data operation. Existing upgrades will
// run it via the normal versioned-migration path.
//
// Idempotent: CREATE OR REPLACE FUNCTION.
module.exports = createNonTransactionalMigration(
    async function up(knex) {
        const client = knex.client.config.client;
        if (client !== 'pg') {
            logging.warn(`Skipping current_site_id() install on non-pg client: ${client}`);
            return;
        }

        logging.info('Installing current_site_id() helper function');
        await knex.raw(`
            CREATE OR REPLACE FUNCTION current_site_id()
                RETURNS varchar(24)
                LANGUAGE sql
                STABLE
                PARALLEL SAFE
            AS $$
                SELECT NULLIF(current_setting('app.site_id', true), '')::varchar(24)
            $$;
        `);
    },
    async function down(knex) {
        const client = knex.client.config.client;
        if (client !== 'pg') return;

        logging.info('Dropping current_site_id() helper function');
        await knex.raw('DROP FUNCTION IF EXISTS current_site_id();');
    }
);
