const {createTransactionalMigration} = require('../../utils');

// Junction tables are INSERTed by Bookshelf's .attach() which bypasses
// model hooks, so site_id always defaults to the hardcoded sentinel.
// With RLS enabled the WITH CHECK policy rejects any row whose site_id
// doesn't match current_site_id(). Fix: make the default expression
// read from the session GUC so Bookshelf's raw junction inserts
// automatically inherit the correct tenant.
const TABLES = ['posts_tags', 'posts_authors', 'posts_meta', 'roles_users', 'permissions_roles'];

const GUC_DEFAULT = `COALESCE(NULLIF(current_setting('app.site_id', true), ''), 'default0000000000000000')`;

module.exports = createTransactionalMigration(
    async function up(knex) {
        for (const table of TABLES) {
            await knex.raw(`ALTER TABLE ${table} ALTER COLUMN site_id SET DEFAULT ${GUC_DEFAULT}`);
        }
    },
    async function down(knex) {
        for (const table of TABLES) {
            await knex.raw(`ALTER TABLE ${table} ALTER COLUMN site_id SET DEFAULT 'default0000000000000000'`);
        }
    }
);
