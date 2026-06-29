const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 2c: enable Postgres Row-Level Security on
// every site-scoped table and install a policy that scopes reads/writes
// to the row's site_id when the GUC `app.site_id` is set.
//
// Policy: `USING (site_id = current_site_id() OR current_site_id() IS NULL)`
//   - HTTP requests (after Phase 1.5b sets the GUC): RLS hard-filters
//     to the active site. A query that forgets the application-layer
//     scope returns ZERO rows from other sites instead of leaking.
//   - System scope (background jobs, migrations, REPL, boot): GUC is
//     unset, `current_site_id()` returns NULL, the OR-NULL clause
//     allows the query through. Phase 4a + 4b + 4c already isolate
//     these correctly via app-layer scoping; RLS is a backstop, not
//     the primary defense.
//
// **Until Phase 1.5b is in production-wired, this policy is a no-op
// for HTTP requests too** (because the GUC is never set). Installing
// it now is groundwork: the moment 1.5b lands, RLS activates without
// further migration.
//
// Targets: every table with a `site_id` column. Computed dynamically
// from information_schema so this stays in sync without listing 78
// names. Excludes the `sites` table itself (which has no site_id —
// it IS the scope).

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') {
            logging.warn(`Skipping RLS install on non-pg client: ${knex.client.config.client}`);
            return;
        }

        const {rows} = await knex.raw(`
            SELECT DISTINCT table_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
            AND column_name = 'site_id'
            ORDER BY table_name
        `);
        const tables = rows.map(r => r.table_name);
        logging.info(`Enabling RLS on ${tables.length} site-scoped tables`);

        for (const table of tables) {
            await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            // Drop any pre-existing policy with our name so the migration
            // is idempotent and any prior partial run can be reversed.
            await knex.raw(`DROP POLICY IF EXISTS townbrief_site_isolation ON ${table}`);
            await knex.raw(`
                CREATE POLICY townbrief_site_isolation ON ${table}
                USING (site_id = current_site_id() OR current_site_id() IS NULL)
                WITH CHECK (site_id = current_site_id() OR current_site_id() IS NULL)
            `);
        }
        logging.info(`RLS policies installed on ${tables.length} tables`);
    },
    async function down(knex) {
        if (knex.client.config.client !== 'pg') return;
        const {rows} = await knex.raw(`
            SELECT tablename FROM pg_policies
            WHERE policyname = 'townbrief_site_isolation'
            AND schemaname = current_schema()
        `);
        for (const r of rows) {
            await knex.raw(`DROP POLICY IF EXISTS townbrief_site_isolation ON ${r.tablename}`);
            await knex.raw(`ALTER TABLE ${r.tablename} DISABLE ROW LEVEL SECURITY`);
        }
    }
);
