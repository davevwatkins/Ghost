const models = require('../../../models');
const ghostBookshelf = require('../../../models/base');
const errors = require('@tryghost/errors');
const limitService = require('../../../services/limits');
const tpl = require('@tryghost/tpl');

const messages = {
    invalidRequest: 'Invalid Request',
    unknownContentApiKey: 'Unknown Content API Key',
    invalidApiKeyType: 'Invalid API Key type'
};

const authenticateContentApiKey = async function authenticateContentApiKey(req, res, next) {
    // allow fallthrough to other auth methods or final ensureAuthenticated check
    if (!req.query || !req.query.key) {
        return next();
    }

    if (req.query.key.constructor === Array) {
        return next(new errors.BadRequestError({
            message: tpl(messages.invalidRequest),
            code: 'INVALID_REQUEST'
        }));
    }

    let key = req.query.key;

    try {
        let apiKey = await models.ApiKey.findOne({secret: key}, {withRelated: ['integration']});

        // TownBrief multitenancy: ghost-internal-frontend is a process-internal integration
        // that only exists on the default site but whose key Portal embeds in every site's
        // server-rendered HTML. The site-scoped Bookshelf lookup above won't find it for
        // non-default sites. Fall back to a cross-site raw query restricted to internal
        // integrations — these keys are never exposed to arbitrary external callers.
        if (!apiKey) {
            const row = await ghostBookshelf.knex('api_keys')
                .join('integrations', 'api_keys.integration_id', 'integrations.id')
                .where('api_keys.secret', key)
                .where('api_keys.type', 'content')
                .where('integrations.type', 'internal')
                .first('api_keys.id', 'api_keys.secret', 'api_keys.type',
                    'api_keys.integration_id', 'api_keys.site_id',
                    'integrations.type as integration_type');
            if (row) {
                // Wrap in a minimal duck-typed object matching what the rest of this
                // function and downstream middleware expect from a Bookshelf ApiKey model.
                // authorize.js reads req.api_key.id directly (not via .get()), so both
                // direct properties and .get() must return the same values.
                apiKey = {
                    id: row.id,
                    get: k => row[k],
                    relations: {
                        integration: {get: k => k === 'type' ? row.integration_type : null}
                    }
                };
            }
        }

        if (!apiKey) {
            return next(new errors.UnauthorizedError({
                message: tpl(messages.unknownContentApiKey),
                code: 'UNKNOWN_CONTENT_API_KEY'
            }));
        }

        if (apiKey.get('type') !== 'content') {
            return next(new errors.UnauthorizedError({
                message: tpl(messages.invalidApiKeyType),
                code: 'INVALID_API_KEY_TYPE'
            }));
        }

        // CASE: blocking all non-internal: "custom" and "builtin" integration requests when the limit is reached
        if (limitService.isLimited('customIntegrations')
            && (apiKey.relations.integration && !['internal', 'core'].includes(apiKey.relations.integration.get('type')))) {
            // NOTE: using "checkWouldGoOverLimit" instead of "checkIsOverLimit" here because flag limits don't have
            //       a concept of measuring if the limit has been surpassed
            await limitService.errorIfWouldGoOverLimit('customIntegrations');
        }

        // authenticated OK, store the api key on the request for later checks and logging
        req.api_key = apiKey;

        next();
    } catch (err) {
        if (err instanceof errors.HostLimitError) {
            next(err);
        } else {
            next(new errors.InternalServerError({err}));
        }
    }
};

module.exports = {
    authenticateContentApiKey
};
