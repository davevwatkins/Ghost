const config = require('../../../shared/config');
const parseYaml = require('./yaml-parser');

let settingsLoader;
let routeSettings;
let settingsPathManagerRef;

// TownBrief multitenancy Phase 4c4: resolve the routes.yaml file to load
// for the currently-active site. Tries `content/sites/<slug>/routes.yaml`
// first; falls back to `content/settings/routes.yaml`. Called per-load
// (not just at boot) so an operator can drop a per-site override and
// have it take effect on the next URL service init without restarting.
function resolveRoutesPathForActiveSite() {
    if (!settingsPathManagerRef) return null;
    let site = null;
    try {
        site = require('../multitenancy/current-site').getCurrentSite();
    } catch (e) { /* multitenancy not loaded yet */ }
    if (site && site.slug) {
        const perSite = settingsPathManagerRef.getPerSiteFilePathIfExists(
            site.slug,
            config.getContentPath('')
        );
        if (perSite) return perSite;
    }
    return settingsPathManagerRef.getDefaultFilePath();
}

module.exports = {
    init: async () => {
        const RouteSettings = require('./route-settings');
        const SettingsLoader = require('./settings-loader');
        const DefaultSettingsManager = require('./default-settings-manager');
        const SettingsPathManager = require('./settings-path-manager');

        const settingsPathManager = new SettingsPathManager({type: 'routes', paths: [config.getContentPath('settings')]});
        settingsPathManagerRef = settingsPathManager;
        settingsLoader = new SettingsLoader({parseYaml, settingFilePath: settingsPathManager.getDefaultFilePath()});
        routeSettings = new RouteSettings({
            settingsLoader,
            settingsPath: settingsPathManager.getDefaultFilePath(),
            backupPath: settingsPathManager.getBackupFilePath()
        });
        const defaultSettingsManager = new DefaultSettingsManager({
            type: 'routes',
            extension: '.yaml',
            destinationFolderPath: config.getContentPath('settings'),
            sourceFolderPath: config.get('paths').defaultRouteSettings
        });

        return await defaultSettingsManager.ensureSettingsFileExists();
    },

    get loadRouteSettings() {
        // Phase 4c4: wrap the loader so each call resolves the right
        // file for the active site. Existing callers see the same
        // function signature; behavior just becomes per-site.
        return async (...args) => {
            const filePath = resolveRoutesPathForActiveSite();
            if (filePath) settingsLoader.settingFilePath = filePath;
            return settingsLoader.loadSettings.apply(settingsLoader, args);
        };
    },
    // Exposed for tests + Phase 4c4b's per-site URL service work.
    __resolveRoutesPathForActiveSite: resolveRoutesPathForActiveSite,
    get getDefaultHash() {
        return routeSettings.getDefaultHash.bind(routeSettings);
    },

    /**
     * Methods used in the API
     */
    api: {
        get setFromFilePath() {
            return routeSettings.setFromFilePath.bind(routeSettings);
        },
        get get() {
            return routeSettings.get.bind(routeSettings);
        },
        get getCurrentHash() {
            return routeSettings.getCurrentHash.bind(routeSettings);
        }
    }
};
