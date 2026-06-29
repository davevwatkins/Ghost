const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');

const activeTheme = require('../active');
const settingsCache = require('../../../../shared/settings-cache');

const messages = {
    missingTheme: 'The currently active theme "{theme}" is missing.'
};

// ### Ensure Active Theme
// Ensure there's a properly set & mounted active theme before attempting to serve a site request
// If there is no active theme, throw an error
// Else, ensure the active theme is mounted
function ensureActiveTheme(req, res, next) {
    // CASE: this means that the theme hasn't been loaded yet i.e. there is no active theme
    const theme = activeTheme.get();
    if (!theme) {
        // This is the one place we ACTUALLY throw an error for a missing theme as it's a request we cannot serve
        return next(new errors.InternalServerError({
            // We use the settingsCache here, because the setting will be set,
            // even if the theme itself is not usable because it is invalid or missing.
            message: tpl(messages.missingTheme, {theme: settingsCache.get('active_theme')})
        }));
    }

    // TownBrief multitenancy Phase 4c2: remount when the active theme
    // for THIS site differs from the theme last mounted on the Express
    // app. In single-theme deployments this never fires after the first
    // request. In mixed-theme deployments it thrashes — see Phase 4c3.
    const mountedThemeName = req.app._townbriefMountedTheme;
    if (!theme.mounted || mountedThemeName !== theme.name) {
        theme.mount(req.app);
    }

    next();
}

module.exports = ensureActiveTheme;
