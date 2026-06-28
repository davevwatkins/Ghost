const assert = require('node:assert/strict');
const Knex = require('knex');
const ObjectId = require('bson-objectid').default;
const validator = require('@tryghost/validator');

const migration = require('../../../../../core/server/data/migrations/versions/6.45/2026-06-28-00-00-00-fix-duplicate-site-uuids');

// Build an in-memory settings table that carries the multitenant `site_id`
// column, then seed one `site_uuid` row per site.
async function setupSettingsDb() {
    const knex = Knex({
        client: 'sqlite3',
        connection: {filename: ':memory:'},
        useNullAsDefault: true
    });

    await knex.raw(`
        CREATE TABLE \`settings\` (
            \`id\` varchar(24) not null,
            \`site_id\` varchar(24) not null,
            \`key\` varchar(50) not null,
            \`value\` text null,
            \`group\` varchar(50) not null,
            \`type\` varchar(50) not null,
            \`flags\` varchar(50) null,
            \`created_at\` datetime not null,
            \`updated_at\` datetime null,
            primary key (\`id\`)
        );
    `);

    return knex;
}

async function insertSiteUuid(knex, siteId, value) {
    await knex('settings').insert({
        id: ObjectId().toHexString(),
        site_id: siteId,
        key: 'site_uuid',
        value,
        group: 'core',
        type: 'string',
        flags: 'PUBLIC,RO',
        created_at: knex.raw('CURRENT_TIMESTAMP')
    });
}

async function runUp(knex) {
    const transacting = await knex.transaction();
    await migration.up({transacting});
    await transacting.commit();
}

function getSiteUuids(knex) {
    return knex('settings').where('key', 'site_uuid').select('site_id', 'value');
}

describe('migrations/6.45/fix-duplicate-site-uuids', function () {
    let knex;

    afterEach(async function () {
        if (knex) {
            await knex.destroy();
            knex = null;
        }
    });

    it('gives every shared/empty site a fresh, unique, valid site_uuid', async function () {
        knex = await setupSettingsDb();

        const SHARED = '6187cf83-9e81-4347-ac30-1696c3d5931f';
        // Three sites share one uuid; two are empty (null + ''); one is unique.
        await insertSiteUuid(knex, 'site_a00000000000000000000', SHARED);
        await insertSiteUuid(knex, 'site_b00000000000000000000', SHARED);
        await insertSiteUuid(knex, 'site_c00000000000000000000', SHARED);
        await insertSiteUuid(knex, 'site_d00000000000000000000', null);
        await insertSiteUuid(knex, 'site_e00000000000000000000', '');
        await insertSiteUuid(knex, 'site_f00000000000000000000', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

        // A non-site_uuid setting that must be left alone.
        await knex('settings').insert({
            id: ObjectId().toHexString(),
            site_id: 'site_a00000000000000000000',
            key: 'title',
            value: 'My Site',
            group: 'core',
            type: 'string',
            created_at: knex.raw('CURRENT_TIMESTAMP')
        });

        await runUp(knex);

        const rows = await getSiteUuids(knex);
        const values = rows.map(r => r.value);

        // No empties remain.
        assert.ok(values.every(v => typeof v === 'string' && v.length > 0), 'every site_uuid is populated');
        // All are valid UUIDs.
        assert.ok(values.every(v => validator.isUUID(v)), 'every site_uuid is a valid UUID');
        // All are unique across sites.
        assert.equal(new Set(values).size, rows.length, 'every site_uuid is unique');

        // The already-unique site kept its value (never shared → untouched).
        const siteF = rows.find(r => r.site_id === 'site_f00000000000000000000');
        assert.equal(siteF.value, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'unique site_uuid is preserved');

        // The unrelated setting is untouched.
        const title = await knex('settings').where('key', 'title').first();
        assert.equal(title.value, 'My Site', 'non-site_uuid settings are not modified');
    });

    it('is a no-op when every site already has a unique site_uuid', async function () {
        knex = await setupSettingsDb();

        await insertSiteUuid(knex, 'site_a00000000000000000000', '11111111-1111-1111-1111-111111111111');
        await insertSiteUuid(knex, 'site_b00000000000000000000', '22222222-2222-2222-2222-222222222222');

        const before = await getSiteUuids(knex);
        await runUp(knex);
        const after = await getSiteUuids(knex);

        assert.deepEqual(
            after.sort((a, b) => a.site_id.localeCompare(b.site_id)),
            before.sort((a, b) => a.site_id.localeCompare(b.site_id)),
            'already-unique values are left unchanged'
        );
    });

    it('is idempotent - a second run changes nothing', async function () {
        knex = await setupSettingsDb();

        const SHARED = '6187cf83-9e81-4347-ac30-1696c3d5931f';
        await insertSiteUuid(knex, 'site_a00000000000000000000', SHARED);
        await insertSiteUuid(knex, 'site_b00000000000000000000', SHARED);
        await insertSiteUuid(knex, 'site_c00000000000000000000', null);

        await runUp(knex);
        const afterFirst = await getSiteUuids(knex);

        await runUp(knex);
        const afterSecond = await getSiteUuids(knex);

        assert.deepEqual(
            afterSecond.sort((a, b) => a.site_id.localeCompare(b.site_id)),
            afterFirst.sort((a, b) => a.site_id.localeCompare(b.site_id)),
            'second run is a no-op once all values are unique'
        );
    });

    it('down() is a no-op and does not throw', async function () {
        knex = await setupSettingsDb();
        await insertSiteUuid(knex, 'site_a00000000000000000000', '11111111-1111-1111-1111-111111111111');

        const transacting = await knex.transaction();
        await migration.down({transacting});
        await transacting.commit();

        const rows = await getSiteUuids(knex);
        assert.equal(rows[0].value, '11111111-1111-1111-1111-111111111111');
    });
});
