/**
 * # Active Theme
 *
 * This file defines a class of active theme, and also controls the getting and setting a single instance, as there
 * can only ever be one active theme. Unlike a singleton, the active theme can change, however only in a controlled way.
 *
 * There are several different patterns available for keeping data private. Elsewhere in Ghost we use the
 * naming convention of the _ prefix. Even though this has the downside of not being truly private, it is still one
 * of the preferred options for keeping data private with the new class syntax, therefore I have kept it.
 *
 * No properties marked with an _ should be used directly.
 *
 */
const fs = require('fs-extra');
const join = require('path').join;

const _ = require('lodash');
const themeConfig = require('./config');
const config = require('../../../shared/config');
const engine = require('./engine');
const themeI18n = require('./i18n');
const themeI18next = require('./i18next');
const labs = require('../../../shared/labs');
const assetHash = require('../asset-hash');
// TownBrief multitenancy Phase 4c: per-site active themes.
// The legacy `currentActiveTheme` singleton is replaced with a
// Map<site_id, ActiveTheme>. `get()` reads the active site from
// AsyncLocalStorage and returns the right one. `set()` accepts an
// explicit siteId (the activation flow knows which site it's
// activating for) and falls back to the active site or 'default'.
//
// IMPORTANT: the `mount(siteApp)` method of ActiveTheme still mutates
// the Express app's views directory. That means two sites with
// different themes will fight over Express config on alternating
// requests. The per-request mount strategy (resolving templates per
// site without app-global mutation) is Phase 4c2 — tracked as a
// separate task.
const activeThemesBySite = new Map();
// Must match the seed default site's id and the schema.js column default.
const DEFAULT_BUCKET = 'default0000000000000000';

let _getCurrentSiteId;
function getCurrentSiteId() {
    if (!_getCurrentSiteId) {
        try {
            _getCurrentSiteId = require('../../../server/services/multitenancy/current-site').getCurrentSiteId;
        } catch (e) {
            return null;
        }
    }
    return _getCurrentSiteId();
}

function bucketKey(explicitSiteId) {
    return explicitSiteId || getCurrentSiteId() || DEFAULT_BUCKET;
}

class ActiveTheme {
    /**
     * @TODO this API needs to be simpler, but for now should work!
     * @param {object} settings
     * @param {string} settings.locale - the active locale for i18n
     * @param {object} loadedTheme - the loaded theme object from the theme list
     * @param {object} checkedTheme - the result of gscan.format for the theme we're activating
     */
    constructor(settings, loadedTheme, checkedTheme) {
        // Assign some data, mark it all as pseudo-private
        this._name = loadedTheme.name;
        this._path = loadedTheme.path;
        this._mounted = false;

        // We get passed in a locale
        this._locale = settings.locale || 'en';

        // @TODO: get gscan to return validated, useful package.json fields for us!
        this._packageInfo = loadedTheme['package.json'];
        this._partials = checkedTheme.partials;

        // all custom .hbs templates (e.g. custom-about)
        this._customTemplates = checkedTheme.templates.custom;

        // all .hbs templates
        this._templates = checkedTheme.templates.all;

        // Create a theme config object
        this._config = themeConfig.create(this._packageInfo);

        this.initI18n();

        this._hasRobotsTxt = fs.existsSync(join(this._path, 'robots.txt'));
    }

    get name() {
        return this._name;
    }

    get customTemplates() {
        return this._customTemplates;
    }

    get path() {
        return this._path;
    }

    get partialsPath() {
        return this._partials.length > 0 ? join(this.path, 'partials') : null;
    }

    // Phase 4c3: cached express-hbs engine instance, populated in mount().
    // The renderer pulls this and constructs a per-request View bound to
    // it, bypassing the app-level engine race.
    get engineInstance() {
        return this._engine;
    }

    get mounted() {
        return this._mounted;
    }

    get error() {
        return this._error;
    }

    hasTemplate(templateName) {
        return this._templates.indexOf(templateName) > -1;
    }

    hasRobotsTxt() {
        return this._hasRobotsTxt;
    }

    updateTemplateOptions(options) {
        engine.updateTemplateOptions(_.merge({}, engine.getTemplateOptions(), options));
    }

    config(key) {
        return this._config[key];
    }

    /**
     *
     * @param {object} options
     * @param {string} [options.activeTheme]
     * @param {string} [options.locale]
     */
    initI18n(options = {}) {
        options.activeTheme = options.activeTheme || this._name;
        options.locale = options.locale || this._locale;

        if (labs.isSet('themeTranslation')) {
            // Initialize the new translation service
            themeI18next.init(options);
        } else {
            // Initialize the legacy translation service
            themeI18n.init(options);
        }
    }

    mount(siteApp) {
        // Reset the global asset hash (used as fallback for non-theme assets)
        config.set('assetHash', null);
        // Clear the file-based asset hash cache (for theme assets)
        assetHash.clearCache();
        // clear the view cache
        siteApp.cache = {};
        // Cache a per-theme hbs engine. Phase 4c3 reads this in the
        // renderer and binds it to a per-request `new View(...)` so
        // mixed-theme operation across sites doesn't race.
        this._engine = engine.configure(this.partialsPath, this.path);
        // Set the views and engine globally too — this keeps the legacy
        // path working for any code that falls through to res.render
        // without going via the rendering service.
        siteApp.set('views', this.path);
        siteApp.engine('hbs', this._engine);

        // TownBrief multitenancy Phase 4c2: stamp the currently-mounted
        // theme name on the Express app. The ensure-active-theme middleware
        // reads this to avoid remounting when the same theme is already in
        // place (common case: many sites share one house theme). When the
        // theme name changes (admin activated a different theme; rare),
        // remount happens. **This does NOT support multiple sites with
        // different themes serving simultaneously** — they will thrash on
        // every request. That requires a per-request views/engine rewrite,
        // tracked as Phase 4c3.
        siteApp._townbriefMountedTheme = this._name;
        this._mounted = true;
    }
}

module.exports = {
    get(opts) {
        const siteId = bucketKey(opts && opts.siteId);
        const hit = activeThemesBySite.get(siteId);
        if (hit) return hit;
        // TownBrief Phase 6: fall back to the default bucket when a
        // site's theme wasn't loaded at boot. Matches the fleet
        // operating model where every site shares one house theme
        // (see deploy/MULTITENANCY.md). Per-site distinct themes
        // require Phase 4c3 — for now, "shared theme by default" is
        // the working answer and makes cross-host rendering succeed.
        if (siteId !== DEFAULT_BUCKET) {
            return activeThemesBySite.get(DEFAULT_BUCKET);
        }
        return undefined;
    },
    /**
     * Set theme. Per-site keyed.
     *
     * At this point we trust that the theme has been validated.
     * Any handling for invalid themes should happen before we get here.
     *
     * @param {object} settings
     * @param {string} settings.locale - the active locale for i18n
     * @param {object} loadedTheme - the loaded theme object from the theme list
     * @param {object} checkedTheme - the result of gscan.format for the theme we're activating
     * @param {object} [opts]
     * @param {string} [opts.siteId] - explicit site id; falls back to AsyncLocalStorage active site, then 'default'
     * @return {ActiveTheme}
     */
    set(settings, loadedTheme, checkedTheme, opts) {
        const siteId = bucketKey(opts && opts.siteId);
        const instance = new ActiveTheme(settings, loadedTheme, checkedTheme);
        activeThemesBySite.set(siteId, instance);
        return instance;
    },
    /**
     * Clear all active-theme caches. Test helper — DO NOT call from
     * production code paths.
     */
    __clearAll() {
        activeThemesBySite.clear();
    }
};
