const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 2b: sweep version. Replaces every
// remaining single-column unique constraint on a per-site table with a
// composite `(site_id, col)` unique. Without this, two sites can't both
// have (for example) a tag with slug 'news' or a user with email
// 'editor@example.com'.
//
// On fresh installs schema.js handles this via @@UNIQUE_CONSTRAINTS@@
// — knex-migrator init creates the composite constraints from the
// start. This migration is for EXISTING installs being upgraded from a
// pre-multitenancy Ghost.
//
// Strategy per (table, col):
//   1. Locate the existing constraint by definition (`UNIQUE (col)`) so
//      we tolerate renames that older Ghost versions may have done.
//   2. Drop it.
//   3. Add `UNIQUE (site_id, col)`, named `<table>_site_id_<col>_unique`,
//      idempotently via DO block.
// Postgres-only.

const TARGETS = [
    ['newsletters', 'name'],
    ['newsletters', 'slug'],
    ['users', 'slug'],
    ['users', 'email'],
    ['roles', 'name'],
    ['permissions', 'name'],
    ['tags', 'slug'],
    ['invites', 'email'],
    ['integrations', 'slug'],
    ['products', 'slug'],
    ['offers', 'name'],
    ['offers', 'code'],
    ['benefits', 'slug'],
    ['labels', 'name'],
    ['labels', 'slug'],
    ['snippets', 'name'],
    ['collections', 'slug'],
    ['email_design_settings', 'slug'],
    ['automations', 'name'],
    ['automations', 'slug'],
    ['jobs', 'name'],
    ['suppressions', 'email']
];

async function dropSingleColUnique(knex, table, col) {
    const found = await knex
        .select('conname')
        .from(knex.raw('pg_constraint'))
        .where('conrelid', knex.raw(`'${table}'::regclass`))
        .where('contype', 'u')
        .whereRaw(`pg_get_constraintdef(oid) = 'UNIQUE (${col})'`)
        .first();
    if (found) {
        logging.info(`Dropping legacy UNIQUE(${col}) on ${table}: ${found.conname}`);
        await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT "${found.conname}"`);
        return true;
    }
    return false;
}

async function addCompositeUnique(knex, table, col) {
    const newName = `${table}_site_id_${col}_unique`;
    await knex.raw(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = '${table}'::regclass
                AND contype = 'u'
                AND pg_get_constraintdef(oid) = 'UNIQUE (site_id, ${col})'
            ) THEN
                ALTER TABLE ${table} ADD CONSTRAINT ${newName} UNIQUE (site_id, ${col});
            END IF;
        END $$;
    `);
    logging.info(`Ensured composite UNIQUE(site_id, ${col}) on ${table}`);
}

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') {
            logging.warn(`Skipping composite-uniques sweep on non-pg client: ${knex.client.config.client}`);
            return;
        }
        for (const [table, col] of TARGETS) {
            await dropSingleColUnique(knex, table, col);
            await addCompositeUnique(knex, table, col);
        }
    },
    async function down(knex) {
        if (knex.client.config.client !== 'pg') return;
        for (const [table, col] of TARGETS) {
            const newName = `${table}_site_id_${col}_unique`;
            await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${newName}`);
            // Recreating the original single-column unique would conflict
            // with multi-site data; on real installs the down path is
            // dangerous, so we only drop the composite.
        }
    }
);
