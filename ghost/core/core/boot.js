// The Ghost Boot Sequence
// -----------------------
// - This is intentionally one big file at the moment, so that we don't have to follow boot logic all over the place
// - This file is FULL of debug statements so we can see timings for the various steps because the boot needs to be as fast as possible
// - As we manage to break the codebase down into distinct components for e.g. the frontend, their boot logic can be offloaded to them
// - app.js is separate as the first example of each component having it's own app.js file colocated with it, instead of inside of server/web
//
// IMPORTANT:
// ----------
// The only global requires here should be overrides + debug so we can monitor timings with DEBUG = ghost: boot * node ghost
require('./server/overrides');
const debug = require('@tryghost/debug')('boot');
// END OF GLOBAL REQUIRES

/**
 * Helper class to create consistent log messages
 */
class BootLogger {
    /**
     * @param {{info: (message: string) => unknown}} logging
     * @param {{metric: (name: string, time: number) => unknown}} metrics
     * @param {number} startTime
     */
    constructor(logging, metrics, startTime) {
        this.logging = logging;
        this.metrics = metrics;
        this.startTime = startTime;
    }
    /**
     * @param {string} message
     * @returns {void}
     */
    log(message) {
        let {logging, startTime} = this;
        logging.info(`Ghost ${message} in ${(Date.now() - startTime) / 1000}s`);
    }
    /**
     * @param {string} name
     * @param {number} [initialTime]
     * @returns {void}
     */
    metric(name, initialTime) {
        let {metrics, startTime} = this;

        if (!initialTime) {
            initialTime = startTime;
        }

        metrics.metric(name, Date.now() - initialTime);
    }
}

/**
 * Helper function to handle sending server ready notifications
 * @param {string} [error]
 */
function notifyServerReady(error) {
    const notify = require('./server/notify');

    if (error) {
        debug('Notifying server ready (error)');
        notify.notifyServerReady(error);
    } else {
        debug('Notifying server ready (success)');
        notify.notifyServerReady();
    }
}

/**
  * Get the Database into a ready state
  * - DatabaseStateManager handles doing all this for us
  *
  * @param {object} options
  * @param {object} options.config
  */
async function initDatabase({config}) {
    const DatabaseStateManager = require('./server/data/db/database-state-manager');
    const dbStateManager = new DatabaseStateManager({knexMigratorFilePath: config.get('paths:appRoot')});
    await dbStateManager.makeReady();

    const databaseInfo = require('./server/data/db/info');
    await databaseInfo.init();

    // TownBrief multitenancy Phase 1.6: ensure the seeded default site
    // row exists. The versioned migration that does this is a no-op on
    // fresh `knex-migrator init` (init marks versioned migrations as
    // applied without running them — by design). A boot-time check is
    // the reliable place to ensure the default row is present.
    await ensureDefaultSite();

    // Same gotcha: the Phase 2c RLS migrations also get skipped on
    // fresh init. Apply RLS idempotently here.
    await ensureRowLevelSecurity();

    // The per-site role seeder clones permissions_roles from the source site;
    // an under-seeded source historically yielded Owner roles with ZERO
    // permissions on every tenant, which renders the admin with no left nav.
    // Backfill idempotently here so a fresh init / new tenant can't reintroduce it.
    await ensureOwnerRolePermissions();
}

async function ensureRowLevelSecurity() {
    const knex = require('./server/data/db').knex;
    if (!knex || knex.client.config.client !== 'pg') return;
    try {
        const {rows: siteIdTables} = await knex.raw(`
            SELECT DISTINCT table_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
            AND column_name = 'site_id'
            ORDER BY table_name
        `);
        const tables = siteIdTables.map(r => r.table_name);
        const logging = require('@tryghost/logging');

        // current_site_id() helper — idempotent CREATE OR REPLACE.
        await knex.raw(`
            CREATE OR REPLACE FUNCTION current_site_id()
                RETURNS varchar(24) LANGUAGE sql STABLE PARALLEL SAFE
            AS $$
                SELECT NULLIF(current_setting('app.site_id', true), '')::varchar(24)
            $$;
        `);

        // townbrief_stamp_site_id() — stamps site_id from the active-site GUC on
        // raw/bulk/pivot inserts that bypass the Phase 3 model-layer scoping
        // (members_newsletters, email_recipients, …) so they satisfy the RLS
        // WITH CHECK. No-op when site_id is already a real site, or in system
        // scope (GUC unset). See TOWNBRIEF-CHANGES.md.
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

        let installed = 0;
        for (const table of tables) {
            const {rows: state} = await knex.raw(
                'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ?',
                [table]
            );
            if (state[0] && state[0].relrowsecurity && state[0].relforcerowsecurity) continue;
            await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
            await knex.raw(`DROP POLICY IF EXISTS townbrief_site_isolation ON ${table}`);
            await knex.raw(`
                CREATE POLICY townbrief_site_isolation ON ${table}
                USING (site_id = current_site_id() OR current_site_id() IS NULL)
                WITH CHECK (site_id = current_site_id() OR current_site_id() IS NULL)
            `);
            installed++;
        }
        if (installed > 0) {
            logging.info(`TownBrief: installed/forced RLS on ${installed} site-scoped tables (boot-time check)`);
        }

        // Install the site_id-stamping BEFORE INSERT trigger on every site-scoped
        // table (idempotent; only creates where missing). Pairs with the RLS
        // WITH CHECK above so raw/bulk/pivot inserts don't get rejected.
        const {rows: existingTriggers} = await knex.raw(`
            SELECT event_object_table FROM information_schema.triggers
            WHERE trigger_name = 'tb_stamp_site_id' AND trigger_schema = current_schema()
        `);
        const tablesWithTrigger = new Set(existingTriggers.map(r => r.event_object_table));
        let triggersInstalled = 0;
        for (const table of tables) {
            if (tablesWithTrigger.has(table)) continue;
            await knex.raw(`CREATE TRIGGER tb_stamp_site_id BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION townbrief_stamp_site_id()`);
            triggersInstalled++;
        }
        if (triggersInstalled > 0) {
            logging.info(`TownBrief: installed site_id-stamping trigger on ${triggersInstalled} site-scoped tables (boot-time check)`);
        }
    } catch (err) {
        require('@tryghost/logging').warn(`ensureRowLevelSecurity skipped: ${err.message}`);
    }
}

// TownBrief: ensure every site's Owner role carries the same permissions as its
// Administrator role. The per-site seeder (services/multitenancy/site-seeders.js)
// clones permissions_roles from the source site; if that source's Owner role is
// under-seeded the defect propagates to every tenant and breaks the admin nav.
// Idempotent: inserts only the permissions an Owner role is missing relative to
// its sibling Administrator. Runs as the non-super ghost_app role with no active
// site (GUC unset) → RLS sees all rows; explicit site_id makes the stamp trigger
// a no-op.
async function ensureOwnerRolePermissions() {
    const knex = require('./server/data/db').knex;
    if (!knex || knex.client.config.client !== 'pg') return;
    try {
        // permissions_roles ships with only (id) and (site_id) indexes here, so the
        // role-scoped anti-join below would seq-scan the whole table per candidate
        // row and stall boot across many tenants (as ghost_app under RLS the planner
        // can't hash-anti-join). Ensure a (role_id, permission_id) index first — it
        // also speeds Ghost's per-role permission lookups generally. Idempotent.
        await knex.raw(`CREATE INDEX IF NOT EXISTS permissions_roles_role_id_permission_id_index ON permissions_roles (role_id, permission_id)`);

        // Cheap guard: once every Owner role holds at least as many permissions as
        // its Administrator sibling fleet-wide, there's nothing to backfill — return
        // immediately rather than run the anti-join INSERT on every boot.
        const {rows: [counts]} = await knex.raw(`
            SELECT
              (SELECT count(*) FROM permissions_roles pr JOIN roles r ON r.id = pr.role_id WHERE r.name = 'Owner') AS owner_total,
              (SELECT count(*) FROM permissions_roles pr JOIN roles r ON r.id = pr.role_id WHERE r.name = 'Administrator') AS admin_total
        `);
        if (Number(counts.owner_total) >= Number(counts.admin_total)) {
            return;
        }

        const result = await knex.raw(`
            INSERT INTO permissions_roles (id, site_id, role_id, permission_id)
            SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24), o.site_id, o.id, pr.permission_id
            FROM roles o
            JOIN roles a ON a.site_id = o.site_id AND a.name = 'Administrator'
            JOIN permissions_roles pr ON pr.role_id = a.id
            WHERE o.name = 'Owner'
              AND NOT EXISTS (
                  SELECT 1 FROM permissions_roles pr2
                  WHERE pr2.role_id = o.id AND pr2.permission_id = pr.permission_id
              )
        `);
        const inserted = result && typeof result.rowCount === 'number' ? result.rowCount : 0;
        if (inserted > 0) {
            require('@tryghost/logging').info(`TownBrief: backfilled ${inserted} Owner-role permissions across sites (boot-time check)`);
        }
    } catch (err) {
        require('@tryghost/logging').warn(`ensureOwnerRolePermissions skipped: ${err.message}`);
    }
}

// TownBrief Phase 4c4e: iterate active sites and create a per-site
// UrlService for each (the default one is created eagerly by the
// module's load itself). Must be called AFTER initDynamicRouting() so
// routerManager._routerParams is populated and can be passed to each
// per-site instance. Per-site errors are logged and swallowed so a
// single broken tenant doesn't stall boot.
async function eagerInitPerSiteUrlServices({urlCache} = {}) {
    const knex = require('./server/data/db').knex;
    if (!knex || knex.client.config.client !== 'pg') return;
    const logging = require('@tryghost/logging');
    let runWithSite;
    let urlService;
    try {
        runWithSite = require('./server/services/multitenancy/current-site').runWithSite;
        urlService = require('./server/services/url');
    } catch (e) {
        logging.warn(`Phase 4c4e skipped: dependencies unavailable (${e.message})`);
        return;
    }
    if (typeof urlService.ensureUrlServiceForSite !== 'function') {
        logging.warn('Phase 4c4e skipped: urlService.ensureUrlServiceForSite not present');
        return;
    }

    // Collect the router generator params that were recorded by
    // routerManager.routerCreated() during initDynamicRouting(). These
    // are replayed onto each per-site UrlService instance so generators
    // subscribe to the queue before resources load (required for the
    // queue's requiredSubscriberCount:1 gate to open).
    let routerParams = [];
    try {
        const routing = require('./frontend/services/routing');
        routerParams = routing.routerManager.getRouterParams();
    } catch (e) {
        logging.warn(`Phase 4c4e: could not get router params (${e.message}); per-site URL maps may be empty`);
    }

    let sites = [];
    try {
        sites = await knex('sites')
            .where('status', 'active')
            .whereNot('id', 'default0000000000000000')
            .select('id', 'slug', 'host', 'custom_domain');
    } catch (err) {
        logging.warn(`Phase 4c4e sites lookup failed: ${err.message}`);
        return;
    }

    if (!sites.length) return;
    logging.info(`Phase 4c4e: initialising UrlService for ${sites.length} non-default site(s) (${routerParams.length} router type(s))`);

    // Sequential init keeps boot output readable and avoids piling
    // every site's resource fetch on top of each other in parallel.
    for (const site of sites) {
        try {
            await runWithSite(site, async () => {
                await urlService.ensureUrlServiceForSite(site, {urlCache, routerParams});
            });
        } catch (err) {
            logging.warn(`Phase 4c4e: init failed for site ${site.slug} (${site.id}): ${err.message}`);
        }
    }
}

async function ensureDefaultSite() {
    const knex = require('./server/data/db').knex;
    if (!knex || knex.client.config.client !== 'pg') return;
    try {
        const existing = await knex('sites').where('slug', 'default').first('id');
        if (existing) return;
        const ObjectID = require('bson-objectid').default;
        const now = knex.fn.now();
        await knex('sites').insert({
            id: 'default0000000000000000',
            slug: 'default',
            name: 'Default Site',
            host: 'localhost',
            custom_domain: null,
            status: 'active',
            stripe_account_id: null,
            mailgun_from: null,
            created_at: now,
            updated_at: now
        });
        // eslint-disable-next-line no-unused-vars
        const _objIdLoaded = ObjectID; // require kept for future per-site seeds
        require('@tryghost/logging').info('Seeded default site row (boot-time check)');
    } catch (err) {
        require('@tryghost/logging').warn(`ensureDefaultSite skipped: ${err.message}`);
    }
}

/**
 * Core is intended to be all the bits of Ghost that are fundamental and we can't do anything without them!
 * (There's more to do to make this true)
 * @param {object} options
 * @param {object} options.ghostServer
 * @param {object} options.config
 * @param {boolean} options.frontend
 */
async function initCore({ghostServer, config, frontend}) {
    debug('Begin: initCore');

    // URL Utils is a bit slow, put it here so the timing is visible separate from models
    debug('Begin: Load urlUtils');
    require('./shared/url-utils');
    debug('End: Load urlUtils');

    // Limit service is booted before settings, so that limits are available for calculated settings
    debug('Begin: limits');
    const limits = require('./server/services/limits');
    await limits.init();
    debug('End: limits');

    // Settings are a core concept we use settings to store key-value pairs used in critical pathways as well as public data like the site title
    debug('Begin: settings');
    const settings = require('./server/services/settings/settings-service');
    await settings.init();
    await settings.syncEmailSettings(config.get('hostSettings:emailVerification:verified'));
    debug('End: settings');

    debug('Begin: i18n');
    const i18n = require('./server/services/i18n');
    await i18n.init();
    debug('End: i18n');

    // The URLService is a core part of Ghost, which depends on models.
    debug('Begin: Url Service');
    const urlService = require('./server/services/url');
    // Note: there is no await here, we do not wait for the url service to finish
    // We can return, but the site will remain in maintenance mode until this finishes
    // This is managed on request: https://github.com/TryGhost/Ghost/blob/main/core/app.js#L10
    urlService.init({
        urlCache: !frontend // hacky parameter to make the cache initialization kick in as we can't initialize labs before the boot
    });

    // Phase 4c4e: eagerInitPerSiteUrlServices() is now called in the
    // main boot sequence AFTER initDynamicRouting() so router params
    // are available for per-site generator replay. Removed from here.
    debug('End: Url Service');

    if (ghostServer) {
        // Job Service allows parts of Ghost to run in the background
        debug('Begin: Job Service');
        const jobService = require('./server/services/jobs');

        if (config.get('server:testmode')) {
            jobService.initTestMode();
        }

        ghostServer.registerCleanupTask(async () => {
            await jobService.shutdown();
        });
        debug('End: Job Service');

        // Mentions Job Service allows mentions to be processed in the background
        debug('Begin: Mentions Job Service');
        const mentionsJobService = require('./server/services/mentions-jobs');

        if (config.get('server:testmode')) {
            mentionsJobService.initTestMode();
        }

        ghostServer.registerCleanupTask(async () => {
            await mentionsJobService.shutdown();
        });
        debug('End: Mentions Job Service');

        ghostServer.registerCleanupTask(async () => {
            await urlService.shutdown();
        });
    }

    debug('End: initCore');
}

/**
 * These are services required by Ghost's frontend.
 * @param {object} options
 * @param {BootLogger} options.bootLogger

 */
async function initServicesForFrontend({bootLogger}) {
    debug('Begin: initServicesForFrontend');

    debug('Begin: Routing Settings');
    const routeSettings = require('./server/services/route-settings');
    await routeSettings.init();
    debug('End: Routing Settings');

    debug('Begin: Redirects');
    const customRedirects = require('./server/services/custom-redirects');
    await customRedirects.init();
    debug('End: Redirects');

    debug('Begin: Link Redirects');
    const linkRedirects = require('./server/services/link-redirection');
    await linkRedirects.init();
    debug('End: Link Redirects');

    debug('Begin: Themes');
    // customThemeSettingsService.api must be initialized before any theme activation occurs
    const customThemeSettingsService = require('./server/services/custom-theme-settings');
    customThemeSettingsService.init();

    const themeService = require('./server/services/themes');
    const themeServiceStart = Date.now();
    await themeService.init();
    bootLogger.metric('theme-service-init', themeServiceStart);
    debug('End: Themes');

    debug('Begin: Offers');
    const offers = require('./server/services/offers');
    await offers.init();
    debug('End: Offers');

    debug('End: initServicesForFrontend');
}

/**
 * Frontend is intended to be just Ghost's frontend
 */
function initFrontend() {
    debug('Begin: initFrontend');

    const helperService = require('./frontend/services/helpers');
    helperService.init();

    debug('End: initFrontend');
}

/**
 * At the moment we load our express apps all in one go, they require themselves and are co-located
 * What we want is to be able to optionally load various components and mount them
 * So eventually this function should go away
 * @param {Object} options
 * @param {boolean} options.backend
 * @param {boolean} options.frontend
 * @param {Object} options.config
 */
async function initExpressApps({frontend, backend, config}) {
    debug('Begin: initExpressApps');

    const parentApp = require('./server/web/parent/app')();
    const vhost = require('@tryghost/mw-vhost');

    // Mount the express apps on the parentApp
    if (backend) {
        // ADMIN + API
        const backendApp = require('./server/web/parent/backend')();
        parentApp.use(vhost(config.getBackendMountPath(), backendApp));
    }

    if (frontend) {
        // SITE + MEMBERS
        // RouterManager and migrated frontend callers expect the facade
        // (getUrlForResource / ownsResource), not the raw eager UrlService
        // (which only exposes the legacy id-based methods).
        const urlService = require('./server/services/url').facade;
        const frontendApp = require('./server/web/parent/frontend')({urlService});
        parentApp.use(vhost(config.getFrontendMountPath(), frontendApp));
    }

    debug('End: initExpressApps');
    return parentApp;
}

/**
 * Initialize prometheus client
 */
function initPrometheusClient({config}) {
    if (config.get('prometheus:enabled')) {
        debug('Begin: initPrometheusClient');
        const prometheusClient = require('./shared/prometheus-client');
        debug('End: initPrometheusClient');
        return prometheusClient;
    }
    return null;
}

/**
 * Dynamic routing is generated from the routes.yaml file
 * When Ghost's DB and core are loaded, we can access this file and call routing.routingManager.start
 * However this _must_ happen after the express Apps are loaded, hence why this is here and not in initFrontend
 * Routing is currently tightly coupled between the frontend and backend
 */
async function initDynamicRouting() {
    debug('Begin: Dynamic Routing');
    const routing = require('./frontend/services/routing');
    const routeSettingsService = require('./server/services/route-settings');
    const bridge = require('./bridge');
    bridge.init();

    // We pass the dynamic routes here, so that the frontend services are slightly less tightly-coupled
    const routeSettings = await routeSettingsService.loadRouteSettings();

    routing.routerManager.start(routeSettings);
    const getRoutesHash = () => routeSettingsService.api.getCurrentHash();

    const settings = require('./server/services/settings/settings-service');
    await settings.syncRoutesHash(getRoutesHash);

    debug('End: Dynamic Routing');
}

/**
 * The app service cannot be loaded unless the frontend is enabled
 * In future, the logic to determine whether this should be loaded should be in the service loader
 */
async function initAppService() {
    debug('Begin: App Service');
    const appService = require('./frontend/services/apps');
    await appService.init();
}

/**
 * Services are components that make up part of Ghost and need initializing on boot
 * These services should all be part of core, frontend services should be loaded with the frontend
 * We are working towards this being a service loader, with the ability to make certain services optional
 */
async function initServices() {
    debug('Begin: initServices');

    debug('Begin: Services');
    const identityTokens = require('./server/services/identity-tokens');
    const stripe = require('./server/services/stripe');
    const members = require('./server/services/members');
    const tiers = require('./server/services/tiers');
    const permissions = require('./server/services/permissions');
    const indexnow = require('./server/services/indexnow');
    const slack = require('./server/services/slack');
    const webhooks = require('./server/services/webhooks');
    const postScheduling = require('./server/services/post-scheduling').default;
    const comments = require('./server/services/comments');
    const staffService = require('./server/services/staff');
    const memberAttribution = require('./server/services/member-attribution');
    const membersEvents = require('./server/services/members-events');
    const linkTracking = require('./server/services/link-tracking');
    const audienceFeedback = require('./server/services/audience-feedback');
    const emailSuppressionList = require('./server/services/email-suppression-list');
    const emailService = require('./server/services/email-service');
    const emailAnalytics = require('./server/services/email-analytics');
    const mentionsService = require('./server/services/mentions');
    const tagsPublic = require('./server/services/tags-public');
    const postsPublic = require('./server/services/posts-public');
    const slackNotifications = require('./server/services/slack-notifications');
    const mediaInliner = require('./server/services/media-inliner');
    const donationService = require('./server/services/donations');
    const giftService = require('./server/services/gifts');
    const recommendationsService = require('./server/services/recommendations');
    const emailAddressService = require('./server/services/email-address');
    const statsService = require('./server/services/stats');
    const explorePingService = require('./server/services/explore-ping');
    const domainEvents = require('@tryghost/domain-events');
    const automations = require('./server/services/automations');

    const {createAdapter: createSchedulerAdapter} = require('./server/adapters/scheduling/utils');
    const urlUtils = require('./shared/url-utils');
    const internalKeys = require('./server/services/internal-keys').default;

    // Initialize things that other services depend on first.
    emailAddressService.init();
    const apiUrl = urlUtils.urlFor('api', {type: 'admin'}, true);
    const schedulerAdapter = createSchedulerAdapter();
    schedulerAdapter.run();
    await stripe.init();

    await Promise.all([
        identityTokens.init(),
        memberAttribution.init(),
        mentionsService.init(),
        staffService.init(),
        members.init(),
        tiers.init(),
        tagsPublic.init(),
        postsPublic.init(),
        membersEvents.init(),
        permissions.init(),
        indexnow.listen(),
        slack.listen(),
        audienceFeedback.init(),
        emailService.init(),
        emailAnalytics.init(),
        webhooks.listen(),
        comments.init(),
        linkTracking.init(),
        emailSuppressionList.init(),
        slackNotifications.init(),
        mediaInliner.init(),
        donationService.init(),
        recommendationsService.init(),
        statsService.init(),
        explorePingService.init(),
        giftService.init({
            apiUrl,
            schedulerAdapter,
            internalKeys
        }),
        automations.init({
            domainEvents,
            apiUrl,
            schedulerAdapter,
            internalKeys
        })
    ]);

    if (schedulerAdapter.rescheduleOnBoot) {
        await postScheduling.rescheduleAll();
    }

    debug('End: Services');

    debug('End: initServices');
}

/**
 * Kick off recurring jobs and background services
 * These are things that happen on boot, but we don't need to wait for them to finish
 * Later, this might be a service hook

 * @param {object} options
 * @param {object} options.config
 */
async function initBackgroundServices({config}) {
    debug('Begin: initBackgroundServices');

    // Load all inactive themes
    const themeService = require('./server/services/themes');
    themeService.loadInactiveThemes();

    // we don't want to kick off background services that will interfere with tests
    if (process.env.NODE_ENV.startsWith('test')) {
        return;
    }

    const activitypub = require('./server/services/activitypub');
    await activitypub.init();
    // Load email analytics recurring jobs
    if (config.get('backgroundJobs:emailAnalytics')) {
        const emailAnalyticsJobs = require('./server/services/email-analytics/jobs');
        await emailAnalyticsJobs.scheduleRecurringJobs();
    }

    const updateCheck = require('./server/services/update-check');
    updateCheck.scheduleRecurringJobs();
    if (config.get('updateCheck:forceUpdate')) {
        updateCheck.scheduleBootJob();
    }

    const milestonesService = require('./server/services/milestones');
    milestonesService.initAndRun();

    // TODO(NY-1220): The outbox is deprecated and will soon be removed.
    const outboxService = require('./server/services/outbox');
    outboxService.init();

    debug('End: initBackgroundServices');
}

/**
 * ----------------------------------
 * Boot Ghost - The magic starts here
 * ----------------------------------
 *
 * - This function is written with async/await so you can read, line by line, what happens on boot
 * - All the functions above handle init/boot logic for a single component

 * @returns {Promise<object>} ghostServer
 */
async function bootGhost({backend = true, frontend = true, server = true} = {}) {
    // Metrics
    const startTime = Date.now();
    debug('Begin Boot');

    // We need access to these variables in both the try and catch block
    let bootLogger;
    let config;
    let ghostServer;
    let logging;
    let metrics;

    // These require their own try-catch block and error format, because we can't log an error if logging isn't working
    try {
        // Step 0 - Load config and logging - fundamental required components
        // Version is required by logging, sentry & Migration config & so is fundamental to booting
        // However, it involves reading package.json so its slow & it's here for visibility on that slowness
        debug('Begin: Load version info');
        require('@tryghost/version');
        debug('End: Load version info');

        // Loading config must be the first thing we do, because it is required for absolutely everything
        debug('Begin: Load config');
        config = require('./shared/config');
        debug('End: Load config');

        // Logging is also used absolutely everywhere
        debug('Begin: Load logging');
        logging = require('@tryghost/logging');
        metrics = require('@tryghost/metrics');
        bootLogger = new BootLogger(logging, metrics, startTime);
        debug('End: Load logging');

        // At this point logging is required, so we can handle errors better

        // Add a process handler to capture and log unhandled rejections
        debug('Begin: Add unhandled rejection handler');
        process.on('unhandledRejection', (error) => {
            logging.error('Unhandled rejection:', error);
        });
        debug('End: Add unhandled rejection handler');
    } catch (error) {
        console.error(error); // eslint-disable-line no-console
        process.exit(1);
    }

    try {
        // Step 1 - require more fundamental components

        // Sentry must be initialized early, but requires config
        debug('Begin: Load sentry');
        const sentry = require('./shared/sentry');
        debug('End: Load sentry');

        // Initialize prometheus client early to enable metrics collection during boot
        // Note: this does not start the metrics server yet to avoid increasing boot time
        const prometheusClient = initPrometheusClient({config});

        // Step 2 - Start server with minimal app in global maintenance mode
        debug('Begin: load server + minimal app');
        const rootApp = require('./app')();

        if (server) {
            const GhostServer = require('./server/ghost-server');
            ghostServer = new GhostServer({url: config.getSiteUrl(), env: config.get('env'), serverConfig: config.get('server')});
            await ghostServer.start(rootApp);
            bootLogger.log('server started');

            // Ensure the prometheus client is stopped when the server shuts down
            ghostServer.registerCleanupTask(async () => {
                if (prometheusClient) {
                    prometheusClient.stop();
                }
            });
            debug('End: load server + minimal app');
        }

        // Step 3 - Get the DB ready
        debug('Begin: Get DB ready');
        await initDatabase({config});
        bootLogger.log('database ready');
        const connection = require('./server/data/db/connection');
        sentry.initQueryTracing(
            connection
        );
        debug('End: Get DB ready');

        // Step 4 - Load Ghost with all its services
        debug('Begin: Load Ghost Services & Apps');
        await initCore({ghostServer, config, frontend});

        // Instrument the knex instance and connection pool if prometheus is enabled
        // Needs to be after initCore because the pool is destroyed and recreated in initCore, which removes the event listeners
        if (prometheusClient) {
            prometheusClient.instrumentKnex(connection);
        }

        await initServicesForFrontend({bootLogger});

        if (frontend) {
            initFrontend();
        }
        const ghostApp = await initExpressApps({frontend, backend, config});

        if (frontend) {
            await initDynamicRouting();
            await initAppService();
            // Phase 4c4e: fire-and-forget so boot is not blocked by
            // per-site resource fetches across potentially 50+ sites.
            // Phase 6b filter covers correctness during the warm-up
            // window (falls back to the default UrlService until each
            // per-site instance is ready). Must start AFTER
            // initDynamicRouting() so routerManager._routerParams is
            // populated for generator replay.
            eagerInitPerSiteUrlServices({urlCache: false}).catch((err) => {
                require('@tryghost/logging').warn(`Phase 4c4e per-site URL service init error: ${err.message}`);
            });
        }

        await initServices();
        debug('End: Load Ghost Services & Apps');

        // Step 5 - Mount the full Ghost app onto the minimal root app & disable maintenance mode
        debug('Begin: mountGhost');
        rootApp.disable('maintenance');
        rootApp.use(config.getSubdir(), ghostApp);
        debug('End: mountGhost');

        // Step 6 - We are technically done here - let everyone know!
        bootLogger.log('booted');
        bootLogger.metric('boot-time');
        notifyServerReady();

        // Step 7 - Init our background services, we don't wait for this to finish
        initBackgroundServices({config});

        // If we pass the env var, kill Ghost
        if (process.env.GHOST_CI_SHUTDOWN_AFTER_BOOT) {
            process.exit(0);
        }

        // We return the server purely for testing purposes
        if (server) {
            debug('End Boot: Returning Ghost Server');
            return ghostServer;
        } else {
            debug('End boot: Returning Root App');
            return rootApp;
        }
    } catch (error) {
        const errors = require('@tryghost/errors');

        // Ensure the error we have is an ignition error
        let serverStartError = error;
        if (!errors.utils.isGhostError(serverStartError)) {
            serverStartError = new errors.InternalServerError({message: serverStartError.message, err: serverStartError});
        }

        logging.error(serverStartError);

        // If ghost was started and something else went wrong, we shut it down
        if (ghostServer) {
            notifyServerReady(serverStartError);
            ghostServer.shutdown(2);
        } else {
            // Ghost server failed to start, set a timeout to give logging a chance to flush
            setTimeout(() => {
                process.exit(2);
            }, 100);
        }
    }
}

module.exports = bootGhost;
