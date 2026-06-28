const crypto = require('crypto');
const {createTransactionalMigration} = require('../../utils');
const logging = require('@tryghost/logging');

// TownBrief multitenancy: repair duplicate / empty `site_uuid` settings.
//
// Background: `site_uuid` is the key Tinybird analytics uses to isolate one
// site's traffic from another's. Two seeding bugs broke that isolation:
//   1. The 5.124 `create-site-uuid-setting` migration captured a single
//      value from `settings-utils.getOrGenerateSiteUuid()` — which memoises
//      one UUID at the process level — so every site that took its value
//      from that cache ended up sharing the SAME uuid.
//   2. `townbrief-add-site.js` seeds settings from default-settings.json,
//      where `site_uuid` defaults to null, so freshly provisioned sites had
//      an EMPTY uuid (e.g. Concord Compass, Lexington Ledger, The Wayland
//      Post) and don't work with Tinybird at all.
//
// This migration assigns a fresh, unique UUID to every site whose
// `site_uuid` is empty OR shared with at least one other site, while leaving
// any site that already has a unique value untouched. The companion fixes
// (lazy `addSetting` value + a per-site UUID in `townbrief-add-site.js`) stop
// the duplication from recurring.
//
// Per-row uniqueness: we generate a fresh `crypto.randomUUID()` for each row
// individually (not one value applied to many rows — that is the very bug we
// are fixing). The Postgres-native equivalent would be a single
// `UPDATE ... SET value = gen_random_uuid()::text`, but doing it in JS keeps
// the migration engine-agnostic and lets us scope precisely to the rows that
// need it.
//
// RLS: migrations run in system scope (the `app.site_id` GUC is unset), so
// `current_site_id()` resolves to NULL and the `townbrief_site_isolation`
// policy's `OR current_site_id() IS NULL` branch lets us read and write every
// site's row — even under FORCE ROW LEVEL SECURITY.

module.exports = createTransactionalMigration(
    async function up(knex) {
        const rows = await knex('settings')
            .where('key', 'site_uuid')
            .select('id', 'site_id', 'value');

        if (!rows.length) {
            logging.warn('No site_uuid settings found - skipping');
            return;
        }

        const isEmpty = value => value === null || value === '';

        // Count how many sites carry each non-empty value, so we can tell a
        // shared (duplicate) value apart from a legitimately unique one.
        const valueCounts = rows.reduce((acc, row) => {
            if (!isEmpty(row.value)) {
                acc.set(row.value, (acc.get(row.value) || 0) + 1);
            }
            return acc;
        }, new Map());

        // If an operator pinned a uuid via config, `settings-service`'s
        // validateSiteUuid() refuses to boot when the DB value differs from
        // it. Never regenerate that exact value, otherwise this repair would
        // brick the next boot. (config.site_uuid is unset in this deployment,
        // so this is a defensive guard for installs that do set it.)
        let configuredSiteUuid = null;
        try {
            const configured = require('../../../../../shared/config').get('site_uuid');
            if (configured) {
                configuredSiteUuid = String(configured).toLowerCase();
            }
        } catch (err) {
            // Config layer not available in this context - ignore.
        }

        const needsFix = rows.filter((row) => {
            if (isEmpty(row.value)) {
                return true;
            }
            if (configuredSiteUuid && row.value.toLowerCase() === configuredSiteUuid) {
                return false;
            }
            return valueCounts.get(row.value) > 1;
        });

        if (!needsFix.length) {
            logging.info('Every site already has a unique site_uuid - nothing to fix');
            return;
        }

        // Update each row in parallel (within the migration transaction).
        // Per-row independent UPDATEs have no inter-row dependency, and
        // knex handles concurrent statements on one trx safely. `.map`
        // is preferred over a `for...of` loop here per the migrations
        // lint rule that bans iteration statements.
        await Promise.all(needsFix.map(async (row) => {
            const freshUuid = crypto.randomUUID().toLowerCase();
            await knex('settings')
                .where('id', row.id)
                .update({
                    value: freshUuid,
                    updated_at: knex.raw('CURRENT_TIMESTAMP')
                });
            logging.info(`Assigned fresh site_uuid to site ${row.site_id}`);
        }));

        logging.info(`Repaired ${needsFix.length} site(s) with a duplicate or empty site_uuid`);
    },
    async function down() {
        // Irreversible data repair: the previous shared/empty values were
        // invalid and intentionally not preserved, so there is nothing to
        // restore. No-op.
        logging.warn('fix-duplicate-site-uuids is a data repair - down() is a no-op');
    }
);
