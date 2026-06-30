const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy: stamp site_id on raw/bulk/pivot inserts.
//
// The Phase 3 Bookshelf plugin stamps site_id on MODEL creates, but several
// code paths insert directly via knex and bypass it — belongsToMany pivot
// attaches (members_newsletters, posts_*), batch inserts (email_recipients),
// etc. Those rows arrive with site_id at the column DEFAULT, which the Phase 2c
// RLS WITH CHECK rejects (default != current_site_id()), 500ing member signup
// and bulk email ("new row violates row-level security policy"). This BEFORE
// INSERT trigger stamps site_id := current_site_id() when the insert didn't set
// a real site, closing the gap at the DB layer.
//
// No-op for inserts that already set a real site_id (the model-layer ones) and
// in system scope (GUC unset -> current_site_id() NULL). Targets every table
// with a site_id column, computed from information_schema. Postgres-only.
//
// Mirrored idempotently in boot.js ensureRowLevelSecurity() because
// knex-migrator skips versioned migrations on fresh `init`.

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') {
            logging.warn(`Skipping site_id triggers on non-pg client: ${knex.client.config.client}`);
            return;
        }

        await knex.raw(`
            CREATE OR REPLACE FUNCTION townbrief_stamp_site_id() RETURNS trigger
                LANGUAGE plpgsql AS $$
            BEGIN
                IF (NEW.site_id IS NULL OR NEW.site_id = 'default0000000000000000')
                   AND current_site_id() IS NOT NULL THEN
                    NEW.site_id := current_site_id();
                END IF;
                RETURN NEW;
            END;
            $$;
        `);

        const {rows} = await knex.raw(`
            SELECT DISTINCT table_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
            AND column_name = 'site_id'
            ORDER BY table_name
        `);
        const tables = rows.map(r => r.table_name);
        for (const table of tables) {
            await knex.raw(`DROP TRIGGER IF EXISTS tb_stamp_site_id ON ${table}`);
            await knex.raw(`CREATE TRIGGER tb_stamp_site_id BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION townbrief_stamp_site_id()`);
        }
        logging.info(`Installed site_id-stamping trigger on ${tables.length} site-scoped tables`);
    },
    async function down(knex) {
        if (knex.client.config.client !== 'pg') return;
        const {rows} = await knex.raw(`
            SELECT event_object_table AS table_name FROM information_schema.triggers
            WHERE trigger_name = 'tb_stamp_site_id' AND trigger_schema = current_schema()
        `);
        for (const r of rows) {
            await knex.raw(`DROP TRIGGER IF EXISTS tb_stamp_site_id ON ${r.table_name}`);
        }
        await knex.raw(`DROP FUNCTION IF EXISTS townbrief_stamp_site_id()`);
    }
);
