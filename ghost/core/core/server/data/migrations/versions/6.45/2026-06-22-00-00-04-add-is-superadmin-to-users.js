const {createNonTransactionalMigration} = require('../../utils');
const {commands} = require('../../../schema');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 5a: add `is_superadmin` boolean to users.
// A superadmin user can access the admin UI of any site (cross-site
// access) and pick between them via the site picker. Per-site users
// only see their own site (the row they belong to via site_id).
//
// No-op on fresh installs (column already in schema.js). On existing
// installs the column is added with defaultTo:false so all existing
// users remain per-site by default; promote to superadmin manually
// (or via a future provisioning script).

// Nullable so Bookshelf inserts that pass null don't violate NOT NULL.
// App code treats null and false equivalently; `=== true` is the test.
const COLUMN_DEF = {type: 'boolean', nullable: true, defaultTo: false};

module.exports = createNonTransactionalMigration(
    async function up(connection) {
        const has = await connection.schema.hasColumn('users', 'is_superadmin');
        if (has) {
            logging.warn('Skipping users.is_superadmin - column already present');
            return;
        }
        logging.info('Adding users.is_superadmin');
        await commands.addColumn('users', 'is_superadmin', connection, COLUMN_DEF);
    },
    async function down(connection) {
        const has = await connection.schema.hasColumn('users', 'is_superadmin');
        if (!has) return;
        logging.info('Dropping users.is_superadmin');
        await commands.dropColumn('users', 'is_superadmin', connection);
    }
);
