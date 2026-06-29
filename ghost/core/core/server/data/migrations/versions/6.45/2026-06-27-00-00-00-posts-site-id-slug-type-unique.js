const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy: posts was missed in the composite-uniques sweep
// (2026-06-22-00-00-06). The legacy UNIQUE(slug, type) constraint is global
// across all tenants — two sites can't both have a post with slug "budget"
// even though they're completely separate publications.
//
// Fix: replace it with UNIQUE(site_id, slug, type) so each site has its own
// slug namespace.

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') {
            logging.warn('Skipping posts slug-type constraint fix on non-pg client');
            return;
        }

        // Drop the legacy global constraint (may have any name from prior Ghost versions)
        const found = await knex
            .select('conname')
            .from(knex.raw('pg_constraint'))
            .where('conrelid', knex.raw("'posts'::regclass"))
            .where('contype', 'u')
            .whereRaw("pg_get_constraintdef(oid) = 'UNIQUE (slug, type)'")
            .first();
        if (found) {
            logging.info(`Dropping legacy UNIQUE(slug, type) on posts: ${found.conname}`);
            await knex.raw(`ALTER TABLE posts DROP CONSTRAINT "${found.conname}"`);
        } else {
            logging.info('No legacy UNIQUE(slug, type) found on posts — already removed or renamed');
        }

        // Add per-site composite unique
        await knex.raw(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'posts'::regclass
                    AND contype = 'u'
                    AND pg_get_constraintdef(oid) = 'UNIQUE (site_id, slug, type)'
                ) THEN
                    ALTER TABLE posts ADD CONSTRAINT posts_site_id_slug_type_unique UNIQUE (site_id, slug, type);
                END IF;
            END $$;
        `);
        logging.info('Ensured composite UNIQUE(site_id, slug, type) on posts');
    },
    async function down(knex) {
        if (knex.client.config.client !== 'pg') return;
        await knex.raw('ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_site_id_slug_type_unique');
    }
);
