// It's important to keep the requires absolutely minimal here,
// As this cache is used in SO many other areas, we may open ourselves to
// circular dependency bugs.
const debug = require('@tryghost/debug')('settings:cache');
const _ = require('lodash');

// URL-type settings whose values may contain __GHOST_URL__ placeholders.
// Expansion is done lazily at get() time using the per-request site URL
// so every tenant gets its own hostname (Phase 4b fix).
const URL_SETTING_KEYS = new Set([
    'cover_image', 'logo', 'icon', 'portal_button_icon',
    'og_image', 'twitter_image', 'pintura_js_url', 'pintura_css_url'
]);

// Lazy require: url-utils is not available at module-load time (circular-dep
// risk) but is guaranteed to be loaded by the time get() is called in a
// live request. Returns null if not yet loadable (e.g. during early boot).
let _urlUtils;
function getUrlUtils() {
    if (!_urlUtils) {
        try {
            _urlUtils = require('../url-utils');
        } catch (e) {
            return null;
        }
    }
    return _urlUtils;
}

// TownBrief multitenancy Phase 4a: this used to be ONE cache; now there is
// one cache per site_id. Public API is unchanged — callers still do
// `settingsCache.get('title')` and the cache reads the active site from
// AsyncLocalStorage (`getCurrentSiteId()`). If no site is active (boot,
// background jobs that haven't entered a site scope), the cache reads from
// the 'default' site bucket so legacy single-tenant code paths keep
// working unchanged.
//
// The require below is deferred — settings-cache is loaded EXTREMELY early
// in boot, before services/multitenancy is reachable in some code paths.
// We lazy-resolve it on each call.
let _getCurrentSiteId;
function getCurrentSiteId() {
    if (!_getCurrentSiteId) {
        try {
            _getCurrentSiteId = require('../../server/services/multitenancy/current-site').getCurrentSiteId;
        } catch (e) {
            // Service not loadable (e.g. during the multitenancy service's
            // own module init). Return null = system scope.
            return null;
        }
    }
    return _getCurrentSiteId();
}

// Must match the seed default site's id AND the schema.js column default
// for `site_id` across every table. Single source of truth so the no-
// active-site fallback bucket aligns with the boot-loaded data bucket.
const DEFAULT_BUCKET = 'default0000000000000000';

// Resolve the site_id bucket key. The boot phase loads all settings before
// any request arrives, so we group by site_id at init time and resolve
// against `'default'` when there's no active site.
function bucketKey(explicitSiteId) {
    if (explicitSiteId) return explicitSiteId;
    return getCurrentSiteId() || DEFAULT_BUCKET;
}

/**
 * @typedef {Object} PublicSettingsCache
 * @property {string|null} site_uuid - The blog's site UUID
 * @property {string|null} title - The blog's title
 * @property {string|null} description - The blog's description
 * @property {string|null} logo - URL to the blog's logo
 * @property {string|null} icon - URL to the blog's icon
 * @property {string|null} accent_color - The blog's accent color
 * @property {string|null} cover_image - URL to the blog's cover image
 * @property {string|null} facebook - Facebook page name
 * @property {string|null} twitter - Twitter username
 * @property {string|null} lang - The blog's language code
 * @property {string|null} locale - The blog's locale
 * @property {string|null} timezone - The blog's timezone
 * @property {string|null} codeinjection_head - Code injected into head
 * @property {string|null} codeinjection_foot - Code injected into footer
 * @property {string|null} navigation - JSON string of navigation items
 * @property {string|null} secondary_navigation - JSON string of secondary navigation items
 * @property {string|null} meta_title - Custom meta title
 * @property {string|null} meta_description - Custom meta description
 * @property {string|null} og_image - Open Graph image URL
 * @property {string|null} og_title - Open Graph title
 * @property {string|null} og_description - Open Graph description
 * @property {string|null} twitter_image - Twitter card image URL
 * @property {string|null} twitter_title - Twitter card title
 * @property {string|null} twitter_description - Twitter card description
 * @property {string|null} members_support_address - Support email for members
 * @property {boolean|null} members_enabled - Whether members feature is enabled
 * @property {boolean|null} allow_self_signup - Whether self signup is allowed
 * @property {boolean|null} members_invite_only - Whether membership is invite only
 * @property {string|null} members_signup_access - Member signup access level
 * @property {boolean|null} paid_members_enabled - Whether paid memberships are enabled
 * @property {string|null} firstpromoter_account - FirstPromoter account ID
 * @property {string|null} portal_button_style - Portal button style
 * @property {string|null} portal_button_signup_text - Portal signup button text
 * @property {string|null} portal_button_icon - Portal button icon
 * @property {string|null} portal_signup_terms_html - Portal signup terms HTML
 * @property {boolean|null} portal_signup_checkbox_required - Whether signup checkbox is required
 * @property {string|null} portal_plans - JSON string of available portal plans
 * @property {string|null} portal_default_plan - Default portal plan
 * @property {boolean|null} portal_name - Whether to show portal names
 * @property {boolean|null} portal_button - Whether to show the portal button
 * @property {boolean|null} comments_enabled - Whether comments are enabled
 * @property {boolean|null} recommendations_enabled - Whether recommendations are enabled
 * @property {boolean|null} outbound_link_tagging - Whether outbound link tagging is enabled
 * @property {string|null} default_email_address - Default email address
 * @property {string|null} support_email_address - Support email address
 * @property {string|null} editor_default_email_recipients - Default email recipients for editor
 * @property {string|null} labs - JSON string of enabled labs features
 * @property {boolean|null} social_web_enabled - Whether social web is enabled
 * @property {boolean|null} web_analytics_enabled - Whether web analytics is enabled
 * @property {boolean|null} web_analytics_configured - Whether web analytics is configured
 * @property {never} [x] - Prevent accessing undefined properties
 */

class CacheManager {
    /**
     * @prop {Object} options
     * @prop {Object} options.publicSettings - key/value pairs of settings which are publicly accessible
     */
    constructor({publicSettings}) {
        // Per-site bucket of caches. Key = site_id, Value = cache store
        // instance (whatever was passed to init via cacheStore + a per-site
        // clone of it). The default bucket exists from the moment init
        // runs; other sites are populated when init sees a settings row
        // with their site_id, or lazily by ensureBucket().
        this._buckets = new Map();
        this._cacheStoreFactory = null; // captured at init for lazy bucket creation
        this.settingsOverrides = {};
        this.publicSettings = publicSettings;
        this.calculatedFields = [];

        this.get = this.get.bind(this);
        this.set = this.set.bind(this);
        this.getAll = this.getAll.bind(this);
        this.getPublic = this.getPublic.bind(this);
        this.reset = this.reset.bind(this);
        this._doGet = this._doGet.bind(this);
        this._updateSettingFromModel = this._updateSettingFromModel.bind(this);
        this._updateCalculatedField = this._updateCalculatedField.bind(this);
    }

    // Get or lazily create the cache store for a site bucket.
    _bucket(siteId) {
        const key = siteId || DEFAULT_BUCKET;
        let bucket = this._buckets.get(key);
        if (!bucket && this._cacheStoreFactory) {
            bucket = this._cacheStoreFactory();
            this._buckets.set(key, bucket);
            debug(`Lazily created settings bucket for site ${key}`);
        }
        return bucket;
    }

    // Local function, only ever used for initializing
    // We deliberately call "set" on each model so that set is a consistent interface
    _updateSettingFromModel(settingModel) {
        debug('Auto updating', settingModel.get('key'));
        // settingModel carries site_id (Phase 2). Use it to route the
        // update to the right bucket so the event handler doesn't need to
        // run inside a runWithSite() scope.
        const siteId = settingModel.get('site_id');
        this.set(settingModel.get('key'), settingModel.toJSON(), {siteId});
    }

    _updateCalculatedField(field) {
        return () => {
            debug('Auto updating', field.key);
            // Calculated fields can depend on the active site, but for now
            // they update across ALL sites. This is acceptable for the
            // current calculated fields (db_hash, members_enabled flags
            // derived from generic config); per-site calculated fields are
            // a Phase 4b problem.
            for (const siteId of this._buckets.keys()) {
                this.set(field.key, field.getSetting(), {siteId});
            }
        };
    }

    _doGet(key, options) {
        const siteId = (options && options.siteId) || bucketKey();
        const bucket = this._bucket(siteId);
        // NOTE: "!bucket" is for when the cache is used before init or for
        // a site that has never been touched. Returns undefined like the
        // pre-multitenant code path did.
        if (!bucket) {
            return;
        }

        let override;
        if (this.settingsOverrides && Object.keys(this.settingsOverrides).includes(key)) {
            // Wrap the override value in an object in case it's a boolean
            override = {value: this.settingsOverrides[key]};
        }

        const cacheEntry = bucket.get(key);

        if (override) {
            cacheEntry.value = override.value;
            cacheEntry.is_read_only = true;
        }

        if (!cacheEntry) {
            return;
        }

        // Don't try to resolve to the value of the setting
        if (options && options.resolve === false) {
            return cacheEntry;
        }

        // Default behavior is to try to resolve the value and return that
        try {
            // CASE: handle literal false
            if (cacheEntry.value === false || cacheEntry.value === 'false') {
                return false;
            }

            // CASE: hotpath early return for strings which are already strings
            if (cacheEntry.type === 'string' && typeof cacheEntry.value === 'string') {
                let val = cacheEntry.value;
                // Expand __GHOST_URL__ per-request for URL-type settings so
                // every tenant gets its own hostname (Phase 4b).
                if (URL_SETTING_KEYS.has(key) && val && val.includes('__GHOST_URL__')) {
                    const urlUtils = getUrlUtils();
                    if (urlUtils) {
                        val = urlUtils.transformReadyToAbsolute(val);
                    }
                }
                return val || null;
            }

            // CASE: if a string contains a number e.g. "1", JSON.parse will auto convert into integer
            if (!isNaN(Number(cacheEntry.value))) {
                return cacheEntry.value || null;
            }

            return JSON.parse(cacheEntry.value) || null;
        } catch (err) {
            return cacheEntry.value || null;
        }
    }

    /**
     * Get a key from the active site's cache. `options.siteId` overrides
     * the AsyncLocalStorage-resolved site (used by event handlers that
     * already know which site triggered them).
     *
     * @param {string} key
     * @param {object} [options]
     * @return {*}
     */
    get(key, options) {
        return this._doGet(key, options);
    }

    /**
     * Set a key on the cache for the active site (or `options.siteId` if
     * supplied — used internally when handling settings.edited events).
     *
     * @param {string} key
     * @param {object} value json version of settings model
     * @param {object} [options]
     */
    set(key, value, options) {
        const siteId = (options && options.siteId) || bucketKey();
        const bucket = this._bucket(siteId);
        if (!bucket) {
            debug(`No bucket for site ${siteId} on set('${key}') — cache not initialised yet`);
            return;
        }
        bucket.set(key, _.cloneDeep(value));
    }

    /**
     * Get the entire cache object for the active site.
     */
    getAll() {
        const siteId = bucketKey();
        const bucket = this._bucket(siteId);
        if (!bucket) return {};
        const keys = bucket.keys();
        const all = {};
        keys.forEach((key) => {
            all[key] = _.cloneDeep(this.get(key, {resolve: false, siteId}));
        });
        return all;
    }

    /**
     * Get all the publicly accessible cache entries with their correct names
     * for the active site.
     * @return {PublicSettingsCache} cache
     */
    getPublic() {
        const siteId = bucketKey();
        /** @type {PublicSettingsCache} */
        let settings = Object.fromEntries(
            Object.keys(this.publicSettings).map(key => [this.publicSettings[key], null])
        );

        for (const newKey in this.publicSettings) {
            settings[newKey] = this._doGet(this.publicSettings[newKey], {siteId}) ?? null;
        }

        // Compute transistor_portal_enabled: only true if main integration AND portal setting are both enabled
        if ('transistor_portal_enabled' in settings) {
            const transistorEnabled = this._doGet('transistor', {siteId});
            const portalEnabled = settings.transistor_portal_enabled;
            settings.transistor_portal_enabled = Boolean(transistorEnabled) && Boolean(portalEnabled);
        }

        return settings;
    }

    /**
     * Initialize the per-site cache buckets.
     *
     * On a fresh boot, `settingsCollection` holds settings for EVERY site —
     * we group them by `site_id` and populate one bucket per site. The
     * cacheStore is used as a factory: we call it once for the default
     * site at init, and the same factory is invoked lazily when a setting
     * arrives for a site we haven't seen yet.
     *
     * @param {import('events').EventEmitter} events
     * @param {import('bookshelf').Collection<import('bookshelf').Model>} settingsCollection
     * @param {Array} calculatedFields
     * @param {Object} cacheStore - cache storage instance based on Cache Base Adapter
     * @param {Object} settingsOverrides - key/value pairs of settings which are overridden (i.e. via config)
     * @return {Object} - the default-site bucket, for callers that expected the old single-cache return
     */
    init(events, settingsCollection, calculatedFields, cacheStore, settingsOverrides) {
        // The legacy contract handed us a single cacheStore instance. With
        // per-site buckets we need a factory that yields fresh siblings.
        // We invoke the adapter's constructor (assumes zero-arg) so the
        // instance is fully initialised (e.g. MemoryCache sets `_data = {}`
        // in its constructor — Object.create on the prototype skips that).
        this._cacheStoreFactory = () => new cacheStore.constructor();

        // Default-site bucket uses the supplied cacheStore directly so any
        // pre-existing reference held by callers continues to work.
        this._buckets.set(DEFAULT_BUCKET, cacheStore);
        this.settingsOverrides = settingsOverrides;
        // First, reset the cache and re-wire events
        this.reset(events);

        if (settingsCollection && settingsCollection.models) {
            // Group by site_id and populate each bucket.
            _.each(settingsCollection.models, this._updateSettingFromModel);
        }

        this.calculatedFields = Array.isArray(calculatedFields) ? calculatedFields : [];

        // Bind to events to automatically keep up-to-date
        events.on('settings.edited', this._updateSettingFromModel);
        events.on('settings.added', this._updateSettingFromModel);
        events.on('settings.deleted', this._updateSettingFromModel);

        // set and bind calculated fields
        this.calculatedFields.forEach((field) => {
            this._updateCalculatedField(field)();
            field.dependents.forEach((dependent) => {
                events.on(`settings.${dependent}.edited`, this._updateCalculatedField(field));
            });
        });

        return this._buckets.get(DEFAULT_BUCKET);
    }

    /**
     * Reset all buckets and the event listeners, must be called during init.
     * @param {import('events').EventEmitter} events
     */
    reset(events) {
        for (const bucket of this._buckets.values()) {
            if (bucket && typeof bucket.reset === 'function') {
                bucket.reset();
            }
        }

        events.removeListener('settings.edited', this._updateSettingFromModel);
        events.removeListener('settings.added', this._updateSettingFromModel);
        events.removeListener('settings.deleted', this._updateSettingFromModel);

        //unbind calculated fields
        this.calculatedFields.forEach((field) => {
            field.dependents.forEach((dependent) => {
                events.removeListener(`settings.${dependent}.edited`, this._updateCalculatedField(field));
            });
        });

        this.calculatedFields = [];
    }
}

module.exports = CacheManager;
