const debug = require('@tryghost/debug')('web:parent');
const config = require('../../../shared/config');
const express = require('../../../shared/express');
const compress = require('compression');
const mw = require('./middleware');

/**
 * @returns {import('express').Application}
 */
module.exports = function setupParentApp() {
    debug('ParentApp setup start');
    const parentApp = express('parent');

    parentApp.use(mw.requestId);
    parentApp.use(mw.logRequest);

    // TownBrief multitenancy: resolve Host -> site before anything else looks
    // at the DB. Stamps the active site on req.site AND in AsyncLocalStorage
    // for downstream Bookshelf models. See deploy/MULTITENANCY.md.
    parentApp.use(mw.siteResolver);

    // Register event emitter on req/res to trigger cache invalidation webhook event
    parentApp.use(mw.emitEvents);

    // enabled gzip compression by default
    if (config.get('compress') !== false) {
        parentApp.use(compress());
    }

    // This sets global res.locals which are needed everywhere
    // @TODO: figure out if this is really needed everywhere? Is it not frontend only...
    parentApp.use(mw.ghostLocals);

    // Enable request queuing if configured
    const queueConfig = config.get('optimization:requestQueue');

    if (queueConfig) {
        parentApp.use(mw.queueRequest(queueConfig));
    }

    debug('ParentApp setup end');

    return parentApp;
};
