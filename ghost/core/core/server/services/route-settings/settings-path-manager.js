const path = require('path');
const tpl = require('@tryghost/tpl');
const format = require('date-fns/format');
const {IncorrectUsageError} = require('@tryghost/errors');

const messages = {
    incorrectPathsParameter: 'Attempted to setup settings path manager without paths values.'
};

class SettingsPathManager {
    /**
     *
     * @param {Object} options
     * @param {String[]} options.paths - file location paths ordered in priority by where to locate them first
     * @param {string} options.type setting file type, e.g: 'routes' or 'redirects'
     * @param {String[]} [options.extensions] the supported file extensions with 'yaml' and 'json' defaults. Note 'yml' extension is ignored on purpose
    */
    constructor({type, paths, extensions = ['yaml', 'json']}) {
        if (!paths || !paths.length) {
            throw new IncorrectUsageError({
                message: tpl(messages.incorrectPathsParameter)
            });
        }

        this.type = type;
        this.filename = type;

        this.paths = paths;
        this.defaultPath = paths[0];

        this.extensions = extensions;
        this.defaultExtension = extensions[0];
    }

    getDefaultFilePath() {
        const settingsFolder = this.defaultPath;
        return path.join(settingsFolder, `${this.filename}.${this.defaultExtension}`);
    }

    // TownBrief multitenancy Phase 4c4: per-site override file location.
    // If `content/sites/<slug>/<type>.yaml` exists, that wins; otherwise
    // the default file location does. Operators can ship custom
    // routes for a single site by dropping a file at the per-site path
    // without disturbing the rest of the fleet.
    //
    // Returns the per-site path IF the file exists on disk, else null
    // (caller falls back to getDefaultFilePath()).
    getPerSiteFilePathIfExists(siteSlug, contentRoot) {
        if (!siteSlug || !contentRoot) return null;
        const fs = require('fs');
        const candidate = path.join(contentRoot, 'sites', siteSlug, `${this.filename}.${this.defaultExtension}`);
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (e) { /* swallow */ }
        return null;
    }

    getBackupFilePath() {
        const settingsFolder = this.defaultPath;
        const dateStamp = format(new Date(), 'yyyy-MM-dd-HH-mm-ss');
        return path.join(settingsFolder, `${this.filename}-${dateStamp}.${this.defaultExtension}`);
    }
}

module.exports = SettingsPathManager;
