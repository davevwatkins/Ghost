const {createNonTransactionalMigration} = require('../../utils');
const {commands} = require('../../../schema');
const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 2: add site_id column to every domain
// table — 79 of the 81 tables in schema.js. The two exclusions:
//   - sites: it IS the scope
//   - brute: IP-keyed rate-limit table, not tenant-scoped
//
// On FRESH installs `knex-migrator init` reads schema.js directly to create
// tables — site_id is already in those definitions, so this migration is a
// no-op (the hasColumn check skips). It only does work on EXISTING
// (single-tenant) Ghost installs being upgraded into the multitenant fork.
//
// Defaults to the seeded `default` site id 'default0000000000000000' so
// existing rows backfill into the default tenant. New writes are stamped
// with the active site_id by Phase 3's Bookshelf override.
//
// FK constraint (references sites.id) is in schema.js for fresh installs;
// here we add the column + index. A follow-up Phase 2b migration will
// emit the explicit ALTER TABLE ADD CONSTRAINT for upgraded installs AND
// rewrite single-column unique constraints (e.g. members.email) as
// composite-per-site.

const TABLES = [
    'posts', 'users', 'settings', 'tags', 'members',
    'newsletters', 'posts_meta', 'posts_authors', 'roles', 'roles_users',
    'permissions', 'permissions_users', 'permissions_roles', 'posts_tags',
    'invites', 'sessions', 'integrations', 'webhooks', 'api_keys',
    'mobiledoc_revisions', 'post_revisions', 'products', 'offers', 'benefits',
    'products_benefits', 'members_products', 'posts_products',
    'members_created_events', 'members_cancel_events', 'members_payment_events',
    'members_login_events', 'members_email_change_events', 'members_status_events',
    'members_product_events', 'members_paid_subscription_events', 'labels',
    'members_labels', 'members_stripe_customers', 'subscriptions',
    'members_stripe_customers_subscriptions', 'members_current_subscription',
    'members_subscription_created_events', 'offer_redemptions',
    'members_subscribe_events', 'donation_payment_events', 'stripe_products',
    'stripe_prices', 'actions', 'emails', 'email_batches', 'email_recipients',
    'email_recipient_failures', 'tokens', 'snippets', 'custom_theme_settings',
    'members_newsletters', 'comments', 'comment_likes', 'comment_reports',
    'jobs', 'redirects', 'members_click_events', 'members_feedback',
    'suppressions', 'email_spam_complaint_events', 'mentions', 'milestones',
    'collections', 'collections_posts', 'recommendations',
    'recommendation_click_events', 'recommendation_subscribe_events', 'outbox',
    'email_design_settings', 'automations', 'welcome_email_automated_emails',
    'welcome_email_automation_runs', 'automated_email_recipients', 'gifts'
];

const SITE_ID_DEFINITION = {
    type: 'string',
    maxlength: 24,
    nullable: false,
    defaultTo: 'default0000000000000000',
    references: 'sites.id',
    index: true
};

module.exports = createNonTransactionalMigration(
    async function up(connection) {
        for (const table of TABLES) {
            const hasColumn = await connection.schema.hasColumn(table, 'site_id');
            if (hasColumn) {
                logging.warn(`Skipping ${table}.site_id - column already present`);
                continue;
            }
            logging.info(`Adding ${table}.site_id`);
            await commands.addColumn(table, 'site_id', connection, SITE_ID_DEFINITION);
        }
    },
    async function down(connection) {
        // Drop in reverse so anything that hangs off it goes first.
        for (const table of [...TABLES].reverse()) {
            const hasColumn = await connection.schema.hasColumn(table, 'site_id');
            if (!hasColumn) {
                logging.warn(`Skipping ${table}.site_id - column already absent`);
                continue;
            }
            logging.info(`Dropping ${table}.site_id`);
            await commands.dropColumn(table, 'site_id', connection);
        }
    }
);
