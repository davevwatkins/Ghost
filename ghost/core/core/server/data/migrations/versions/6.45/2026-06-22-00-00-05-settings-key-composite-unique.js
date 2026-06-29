const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 2b (settings table): replace the single-
// column unique constraint on `settings.key` with a composite
// `(site_id, key)` unique. This lets every site own its own copy of
// every setting key (e.g. 'title', 'description') — without this,
// provisioning a second site fails on the first settings INSERT.
//
// Constraint name picked to match Knex's default-naming convention so
// `\d settings` reads clearly. On fresh installs the schema.js entry
// declares this via @@UNIQUE_CONSTRAINTS@@, so this migration is a
// no-op (the constraint will already be named differently for fresh
// installs but the column-level `unique` flag is gone — the only
// upgrade pain is for existing installs that have the old name).

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        const client = knex.client.config.client;
        if (client !== 'pg') {
            logging.warn(`Skipping settings unique constraint migration on non-pg client: ${client}`);
            return;
        }

        // Drop the original single-column unique. Constraint name in pg is
        // typically `settings_key_unique` (Knex-default) but might differ
        // on installs that came from older versions — check existence
        // first via information_schema.
        const oldName = await knex
            .select('conname')
            .from(knex.raw('pg_constraint'))
            .where('conrelid', knex.raw("'settings'::regclass"))
            .where('contype', 'u')
            .whereRaw("pg_get_constraintdef(oid) = 'UNIQUE (key)'")
            .first();

        if (oldName) {
            logging.info(`Dropping legacy unique constraint: ${oldName.conname}`);
            await knex.raw(`ALTER TABLE settings DROP CONSTRAINT "${oldName.conname}"`);
        } else {
            logging.warn('No single-column UNIQUE(key) on settings found - assuming already migrated');
        }

        // Add the composite unique. Idempotent via DO block.
        await knex.raw(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'settings'::regclass
                    AND contype = 'u'
                    AND pg_get_constraintdef(oid) = 'UNIQUE (site_id, key)'
                ) THEN
                    ALTER TABLE settings ADD CONSTRAINT settings_site_id_key_unique UNIQUE (site_id, key);
                END IF;
            END $$;
        `);
        logging.info('Added composite unique (site_id, key) on settings');
    },
    async function down(knex) {
        const client = knex.client.config.client;
        if (client !== 'pg') return;
        logging.info('Reverting settings unique to single-column (key)');
        await knex.raw('ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_site_id_key_unique');
        await knex.raw('ALTER TABLE settings ADD CONSTRAINT settings_key_unique UNIQUE (key)');
    }
);
