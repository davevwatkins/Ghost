const {createNonTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy: allow the ghost-internal-frontend api_key to be
// visible cross-site in RLS.
//
// Background: Ghost's content API uses a shared process-internal integration
// called `ghost-internal-frontend` to authenticate Portal.js. There is only
// ONE such integration (created by fixture seeding on the default site). Its
// content API key is embedded in every site's server-rendered HTML by
// `getFrontendKey()` (via the process-level `internalKeys` AutoFillingMap,
// which caches the key at boot with no site GUC set).
//
// The RLS policies installed in 2026-06-22-...-07 scope every `api_keys` and
// `integrations` row to its `site_id`. As a result:
//   - `models.ApiKey.findOne({secret: key})` (Bookshelf + Phase 3) sees only
//     the current site's rows → returns null for any non-default site.
//   - Even a raw-knex fallback query fails because the `integrations` join is
//     also RLS-filtered (the default site's integration is invisible in a
//     non-default-site context).
//
// Fix (two-part):
//   1. Update the `integrations` policy to expose `ghost-internal-frontend`
//      rows in any site context. This is the anchor that makes step 2 work.
//   2. Update the `api_keys` policy with a plain EXISTS subquery that checks
//      whether the api_key's integration is the ghost-internal-frontend one.
//      Because step 1 makes that integration visible cross-site, the subquery
//      succeeds without a SECURITY DEFINER bypass function.
//
// No SECURITY DEFINER function is needed: the integrations policy update
// (step 1) is sufficient to make the EXISTS subquery in step 2 resolve.
//
// Security rationale: the `ghost-internal-frontend` content key only grants
// read access to published public content — the same data served without auth.
// Portal.js is served by this same Ghost process; sharing the key cross-site
// does not lower the security bar.
//
// Node.js companion: `content.js` authenticateContentApiKey has a raw-knex
// fallback for when the site-scoped Bookshelf lookup returns null. With these
// policies the fallback always finds the key (it joins api_keys → integrations
// and both are now visible cross-site for this one integration).

module.exports = createNonTransactionalMigration(
    async function up(knex) {
        if (knex.client.config.client !== 'pg') {
            logging.warn(`Skipping ghost-internal-frontend RLS fix on non-pg client: ${knex.client.config.client}`);
            return;
        }

        logging.info('Updating integrations RLS: allow ghost-internal-frontend cross-site');
        await knex.raw(`
            DROP POLICY IF EXISTS townbrief_site_isolation ON integrations;
            CREATE POLICY townbrief_site_isolation ON integrations
                FOR ALL
                USING (
                    (site_id::text = current_site_id()::text)
                    OR (current_site_id() IS NULL)
                    OR (slug = 'ghost-internal-frontend')
                )
        `);

        logging.info('Updating api_keys RLS: allow ghost-internal-frontend cross-site via plain EXISTS');
        await knex.raw(`
            DROP POLICY IF EXISTS townbrief_site_isolation ON api_keys;
            CREATE POLICY townbrief_site_isolation ON api_keys
                FOR ALL
                USING (
                    (site_id::text = current_site_id()::text)
                    OR (current_site_id() IS NULL)
                    OR EXISTS (
                        SELECT 1 FROM integrations i
                        WHERE i.id = api_keys.integration_id
                        AND i.slug = 'ghost-internal-frontend'
                    )
                )
        `);
    },

    async function down(knex) {
        if (knex.client.config.client !== 'pg') {
            return;
        }

        // Restore the original policies (without the internal-frontend bypass)
        await knex.raw(`
            DROP POLICY IF EXISTS townbrief_site_isolation ON integrations;
            CREATE POLICY townbrief_site_isolation ON integrations
                FOR ALL
                USING (
                    (site_id::text = current_site_id()::text)
                    OR (current_site_id() IS NULL)
                )
        `);

        await knex.raw(`
            DROP POLICY IF EXISTS townbrief_site_isolation ON api_keys;
            CREATE POLICY townbrief_site_isolation ON api_keys
                FOR ALL
                USING (
                    (site_id::text = current_site_id()::text)
                    OR (current_site_id() IS NULL)
                )
        `);
    }
);
