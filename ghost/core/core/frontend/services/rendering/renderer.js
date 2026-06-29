const path = require('path');
const debug = require('@tryghost/debug')('services:routing:renderer:renderer');
const {IncorrectUsageError} = require('@tryghost/errors');
const setContext = require('./context');
const templates = require('./templates');
const tpl = require('@tryghost/tpl');
const messages = {
    couldNotReadFile: 'Could not read file {file}'
};

// TownBrief multitenancy Phase 4c3: lazy require to dodge circular boot
// dep — the theme engine eventually requires this renderer.
let _activeTheme;
function getActiveTheme() {
    if (!_activeTheme) {
        _activeTheme = require('../theme-engine/active');
    }
    return _activeTheme.get();
}

// Express's View constructor. We construct one per request bound to the
// active site's theme path + cached hbs engine, so two sites with two
// themes can render simultaneously without racing on app-level `views`
// or `app.engine('hbs', ...)` config. Mirrors the contract `res.render`
// runs internally but takes the per-request data from the ActiveTheme.
const View = require('express/lib/view');

function renderViaActiveTheme(req, res, template, data, callback) {
    const theme = getActiveTheme();
    if (!theme || !theme.engineInstance) {
        // No theme cached for this site (boot hasn't loaded one yet or
        // the engine wasn't populated). Fall through to the legacy
        // `res.render` which uses the app-level views/engine config.
        return res.render(template, data, callback);
    }
    let view;
    try {
        view = new View(template, {
            defaultEngine: 'hbs',
            root: theme.path,
            engines: {'.hbs': theme.engineInstance}
        });
    } catch (err) {
        return callback(err);
    }
    if (!view.path) {
        const enoent = new Error(`Failed to lookup view "${template}" in views directory "${theme.path}"`);
        enoent.code = 'ENOENT';
        enoent.path = path.join(theme.path, template + '.hbs');
        return callback(enoent);
    }
    // Mirror res.render's behavior of merging app.locals + res.locals
    // into the render options, including the _locals self-reference that
    // Express injects (see express/lib/response.js renderFile call).
    // ghost_head and other helpers gate on dataRoot._locals being present.
    const opts = {};
    const app = req && req.app;
    if (app && app.locals) Object.assign(opts, app.locals);
    if (res && res.locals) Object.assign(opts, res.locals);
    Object.assign(opts, data || {});
    opts._locals = (res && res.locals) || {};
    view.render(opts, callback);
}

/**
 * @description Helper function to finally render the data.
 * @param {Object} req
 * @param {Object} res
 * @param {Object} data
 */
module.exports = function renderer(req, res, data) {
    // Set response context
    setContext(req, res, data);

    // Set template
    templates.setTemplate(req, res, data);

    debug('Rendering template: ' + res._template + ' for: ' + req.originalUrl);
    debug('res.locals', res.locals);

    // CASE: You can set the content type of the page in your routes.yaml file
    if (res.routerOptions && res.routerOptions.contentType) {
        if (res.routerOptions.templates.indexOf(res._template) !== -1) {
            res.type(res.routerOptions.contentType);
        }
    }

    // Render Call — per-request, bound to the active theme. Phase 4c3.
    renderViaActiveTheme(req, res, res._template, data, function (err, html) {
        if (err) {
            if (err.code === 'ENOENT') {
                return req.next(
                    new IncorrectUsageError({
                        message: tpl(messages.couldNotReadFile, {file: path.basename(err.path)})
                    })
                );
            }
            return req.next(err);
        }
        res.send(html);
    });
};
