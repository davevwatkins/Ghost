const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 1.5b/2c follow-up: by default Postgres
// BYPASSES Row-Level Security for table owners. The Ghost DB user owns
// every table in the schema, so the Phase 2c RLS policies were dormant.
// `ALTER TABLE ... FORCE ROW LEVEL SECURITY` makes RLS apply to the
// owner too — which is what we want, because the Ghost app connects
// AS the owner. Without this, RLS is a no-op even when the GUC is set.

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') return;
        const {rows} = await knex.raw(`
            SELECT tablename FROM pg_policies
            WHERE policyname = 'townbrief_site_isolation'
            AND schemaname = current_schema()
            ORDER BY tablename
        `);
        for (const r of rows) {
            await knex.raw(`ALTER TABLE ${r.tablename} FORCE ROW LEVEL SECURITY`);
        }
        logging.info(`Forced RLS on ${rows.length} site-scoped tables`);
    },
    async function down(knex) {
        if (knex.client.config.client !== 'pg') return;
        const {rows} = await knex.raw(`
            SELECT tablename FROM pg_policies
            WHERE policyname = 'townbrief_site_isolation'
            AND schemaname = current_schema()
        `);
        for (const r of rows) {
            await knex.raw(`ALTER TABLE ${r.tablename} NO FORCE ROW LEVEL SECURITY`);
        }
    }
);
