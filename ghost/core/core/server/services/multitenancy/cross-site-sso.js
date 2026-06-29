// TownBrief multitenancy Phase 5d: cross-site SSO for superadmins.
//
// Flow:
//   1. Superadmin signed-in on the origin site (e.g. default) clicks a
//      site in the picker.
//   2. Frontend POSTs to /ghost/api/admin/session/sso-token with
//      {site_id}. Endpoint mints a one-time signed token and returns
//      a redirect URL on the target host.
//   3. Frontend navigates the browser to that URL.
//   4. Target site's site-resolver middleware sets active site context.
//   5. The redeem endpoint validates the token, finds/creates the
//      superadmin's mirror user on the target site (Owner role on
//      that site, same email, is_superadmin=true), establishes a Ghost
//      session for that user with verified=true (no 2FA — the user
//      is already proven on the origin site), and 302-redirects to
//      /ghost/.
//   6. The browser lands on the target site's admin UI with a session
//      cookie scoped to that host. Signed in.
//
// Security:
//   - Tokens are HMAC-SHA256 of {userId, targetSiteId, exp, nonce}
//     using `admin_session_secret` as the key. Site-local secret so
//     leak of one site's secret doesn't compromise others; we use
//     the ORIGIN site's secret for signing and the TARGET site's for
//     nothing (the mint endpoint runs on origin; the redeem endpoint
//     must verify with the origin's secret too — so the secret has to
//     be readable by the redeem path even though it runs on target).
//     For now we use settings.admin_session_secret from the DEFAULT
//     site (queried directly via knex bypassing Phase 3 scoping) as
//     the shared signing key. Token TTL = 60 seconds.
//   - Nonces are one-time-use, tracked in an in-memory set per
//     process. A second redeem with the same nonce 410s. For multi-
//     process safety this would move to Redis, but local dev is
//     single-process and prod can move it later.
//   - Only superadmins can mint. The mint endpoint refuses non-
//     superadmins.

const crypto = require('crypto');
const errors = require('@tryghost/errors');
const ObjectID = require('bson-objectid').default;

const TOKEN_TTL_MS = 60_000;
const DEFAULT_SITE_ID = 'default0000000000000000';

// In-process nonce blacklist. Map<nonce, expiry-ms>. Cleaned lazily.
const usedNonces = new Map();
function pruneUsedNonces(now) {
    for (const [nonce, exp] of usedNonces) {
        if (exp < now) usedNonces.delete(nonce);
    }
}

function getSigningSecret() {
    // Read from the in-memory settings cache (Phase 4a), addressed by
    // explicit `siteId` so we always sign with the DEFAULT site's
    // secret — origin and target sites can verify with the same key
    // without any DB read at request time. This sidesteps RLS entirely
    // and avoids the Postgres connection-hook ordering question.
    const settingsCache = require('../../../shared/settings-cache');
    const value = settingsCache.get('admin_session_secret', {siteId: DEFAULT_SITE_ID});
    if (!value) {
        throw new errors.InternalServerError({
            message: 'admin_session_secret missing on default site (cross-site SSO disabled)'
        });
    }
    return value;
}

function sign(payload, secret) {
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json, 'utf8').toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
    return `${b64}.${mac}`;
}

function verifySignature(token, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [b64, mac] = parts;
    const expected = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
    // Constant-time compare
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
}

/**
 * Mint a one-time cross-site SSO token. Caller must have already
 * verified the requesting user is a superadmin.
 *
 * @param {object} args
 * @param {import('knex')} args.knex
 * @param {string} args.userId - the originating superadmin user_id
 * @param {string} args.targetSiteId
 * @returns {Promise<{token: string, exp: number}>}
 */
async function mintToken({knex, userId, targetSiteId}) {
    if (!userId) throw new errors.BadRequestError({message: 'userId required'});
    if (!targetSiteId) throw new errors.BadRequestError({message: 'targetSiteId required'});
    const secret = getSigningSecret();
    const now = Date.now();
    const exp = now + TOKEN_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('base64url');
    const payload = {userId, targetSiteId, exp, nonce};
    return {token: sign(payload, secret), exp};
}

/**
 * Verify a cross-site SSO token and consume its nonce. Returns the
 * decoded payload on success. Throws on expired / invalid / replayed.
 *
 * @param {object} args
 * @param {import('knex')} args.knex
 * @param {string} args.token
 * @returns {Promise<{userId: string, targetSiteId: string, exp: number, nonce: string}>}
 */
async function verifyAndConsumeToken({knex, token}) {
    const secret = getSigningSecret();
    const payload = verifySignature(token, secret);
    if (!payload) {
        throw new errors.UnauthorizedError({message: 'Invalid SSO token signature'});
    }
    const now = Date.now();
    pruneUsedNonces(now);
    if (typeof payload.exp !== 'number' || payload.exp < now) {
        throw new errors.UnauthorizedError({message: 'SSO token expired'});
    }
    if (usedNonces.has(payload.nonce)) {
        throw new errors.UnauthorizedError({message: 'SSO token already used'});
    }
    usedNonces.set(payload.nonce, payload.exp);
    return payload;
}

/**
 * Find or create a superadmin mirror user on the target site. The
 * mirror has the same email + password hash as the source superadmin
 * and is assigned the Owner role on the target site.
 *
 * @param {object} args
 * @param {import('knex')} args.knex
 * @param {string} args.sourceUserId
 * @param {string} args.targetSiteId
 * @returns {Promise<{userId: string, created: boolean}>}
 */
async function findOrCreateMirrorUser({knex, sourceUserId, targetSiteId}) {
    // All cross-site queries here MUST bypass RLS — we're crossing
    // tenants by design. Run inside `runWithoutSite()` so the per-
    // connection app.site_id GUC is empty and RLS's "no scope = all
    // rows" fallback kicks in.
    const {runWithoutSite} = require('./current-site');

    return runWithoutSite(async () => {
        const source = await knex('users').where('id', sourceUserId).first();
        if (!source) {
            throw new errors.UnauthorizedError({message: 'Source user not found'});
        }
        if (!source.is_superadmin) {
            throw new errors.NoPermissionError({message: 'Cross-site SSO requires superadmin'});
        }

        // Look for an existing user with the same email on the target site.
        const existing = await knex('users')
            .where('site_id', targetSiteId)
            .andWhere('email', source.email)
            .first();
        if (existing) {
            return {userId: existing.id, created: false};
        }

        // Create a fresh user row. Owner role on target site.
        const ownerRole = await knex('roles')
            .where('site_id', targetSiteId)
            .andWhere('name', 'Owner')
            .first('id');
        if (!ownerRole) {
            throw new errors.InternalServerError({
                message: `Target site ${targetSiteId} has no Owner role seeded (Phase 9c required)`
            });
        }

        const newUserId = (new ObjectID()).toHexString();
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await knex.transaction(async (trx) => {
            await trx('users').insert({
                id: newUserId,
                site_id: targetSiteId,
                email: source.email,
                name: source.name,
                slug: source.slug + '-mirror',
                password: source.password,
                is_superadmin: true,
                status: 'active',
                visibility: source.visibility || 'public',
                created_at: now,
                updated_at: now
            });
            await trx('roles_users').insert({
                id: (new ObjectID()).toHexString(),
                site_id: targetSiteId,
                role_id: ownerRole.id,
                user_id: newUserId
            });
        });
        return {userId: newUserId, created: true};
    });
}

module.exports = {
    mintToken,
    verifyAndConsumeToken,
    findOrCreateMirrorUser,
    // Exported for tests:
    __sign: sign,
    __verifySignature: verifySignature,
    __resetNonceStore: () => usedNonces.clear()
};
