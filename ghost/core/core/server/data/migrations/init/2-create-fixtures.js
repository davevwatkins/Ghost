const {fixtureManager} = require('../../schema/fixtures');

module.exports.config = {
    transaction: true
};

// TownBrief multitenancy Phase 1.6: every site-scoped table has
// `site_id DEFAULT 'default0000000000000000' REFERENCES sites(id)`.
// Fixtures (roles, permissions, etc.) get inserted with that default,
// so the FK target row MUST exist before fixtures load. Seed it here.
async function ensureDefaultSiteRow(knex) {
    const existing = await knex('sites').where('slug', 'default').first('id');
    if (existing) return;
    const now = knex.fn.now();
    await knex('sites').insert({
        id: 'default0000000000000000',
        slug: 'default',
        name: 'Default Site',
        host: 'localhost',
        custom_domain: null,
        status: 'active',
        stripe_account_id: null,
        mailgun_from: null,
        created_at: now,
        updated_at: now
    });
}

module.exports.up = async function insertFixtures(options) {
    const knex = options.transacting || options.connection;
    await ensureDefaultSiteRow(knex);
    return await fixtureManager.addAllFixtures(options);
};
