// TownBrief multitenancy Phase 5d: cross-site SSO HTTP handlers.
// See ghost/core/core/server/services/multitenancy/cross-site-sso.js
// for the architecture summary. These handlers wrap the service in
// Express request/response semantics:
//   - mintHandler: JSON POST, returns {redirect_url}
//   - redeemHandler: GET ?token=..., establishes session + 302s to /ghost/

const errors = require('@tryghost/errors');
const sso = require('../../../../services/multitenancy/cross-site-sso');

let _sessionService;
function getSessionService() {
    if (!_sessionService) {
        _sessionService = require('../../../../services/auth/session').sessionService;
    }
    return _sessionService;
}

let _models;
function getModels() {
    if (!_models) _models = require('../../../../models');
    return _models;
}

let _db;
function getDb() {
    if (!_db) _db = require('../../../../data/db');
    return _db;
}

// POST /ghost/api/admin/session/sso-token
// Auth-protected (mw.authAdminApi must run before this handler).
// Body: {site_id: string}
// Response: {redirect_url: string, expires_at: number}
async function mintHandler(req, res, next) {
    try {
        const session = req.session;
        const userId = session && session.user_id;
        if (!userId) {
            throw new errors.UnauthorizedError({message: 'Sign-in required'});
        }
        const targetSiteId = req.body && req.body.site_id;
        if (!targetSiteId) {
            throw new errors.BadRequestError({message: 'site_id required'});
        }

        const knex = getDb().knex;

        // Verify caller is superadmin.
        const caller = await knex('users').where('id', userId).first('is_superadmin', 'email');
        if (!caller || !caller.is_superadmin) {
            throw new errors.NoPermissionError({message: 'Cross-site SSO is restricted to superadmins'});
        }

        // Look up target site host.
        const targetSite = await knex('sites')
            .where('id', targetSiteId)
            .andWhere('status', 'active')
            .first('id', 'host', 'custom_domain');
        if (!targetSite) {
            throw new errors.NotFoundError({message: 'Target site not found'});
        }

        const {token, exp} = await sso.mintToken({knex, userId, targetSiteId});

        // Build the redirect URL on the target host. Pull the scheme
        // from the browser's Origin header rather than X-Forwarded-Proto:
        // the dev gateway sets X-Forwarded-Proto=https even on plain
        // http://localhost, which would produce an unreachable https URL.
        // Origin reflects the user's real address bar; falls back to
        // X-Forwarded-Proto, then to req.protocol.
        let scheme = 'http';
        const origin = req.get('origin');
        if (origin) {
            try { scheme = new URL(origin).protocol.replace(':', ''); } catch (_) { /* fall through */ }
        } else if (req.get('x-forwarded-proto')) {
            scheme = req.get('x-forwarded-proto').split(',')[0].trim();
        } else if (req.protocol) {
            scheme = req.protocol;
        }
        const host = targetSite.custom_domain || targetSite.host;
        const redirectUrl = `${scheme}://${host}/ghost/api/admin/session/sso-redeem?token=${encodeURIComponent(token)}`;
        res.status(200).json({redirect_url: redirectUrl, expires_at: exp});
    } catch (err) {
        next(err);
    }
}

// GET /ghost/api/admin/session/sso-redeem?token=...
// NO auth required — the token IS the authentication.
// Side effects: creates mirror user if absent, establishes Ghost
// session with verified=true, 302s to /ghost/.
async function redeemHandler(req, res, next) {
    try {
        const token = req.query && req.query.token;
        if (!token) {
            throw new errors.BadRequestError({message: 'token required'});
        }
        const knex = getDb().knex;

        const payload = await sso.verifyAndConsumeToken({knex, token});

        const models = getModels();
        const sessionService = getSessionService();

        // findOrCreate the mirror user on the target site.
        const {userId: targetUserId} = await sso.findOrCreateMirrorUser({
            knex,
            sourceUserId: payload.userId,
            targetSiteId: payload.targetSiteId
        });

        // Load the target-site user via Bookshelf (Phase 3 plugin will
        // scope by active site via the Host-resolved site context).
        const user = await models.User.findOne(
            {id: targetUserId},
            {context: {internal: true, allowCrossSite: true}}
        );
        if (!user) {
            throw new errors.InternalServerError({
                message: 'Mirror user not loadable after creation'
            });
        }

        await sessionService.createVerifiedSessionForUser(req, res, user);

        // Redirect to the admin UI on this host. Relative path keeps
        // the same scheme + host (target site).
        res.redirect(303, '/ghost/');
    } catch (err) {
        next(err);
    }
}

module.exports = {mintHandler, redeemHandler};
