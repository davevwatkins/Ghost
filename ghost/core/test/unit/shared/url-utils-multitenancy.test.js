const assert = require('node:assert/strict');
const sinon = require('sinon');

// Load config first so url-utils' singleton picks it up at require time.
const config = require('../../../core/shared/config');

const urlUtils = require('../../../core/shared/url-utils');
const {runWithSite} = require('../../../core/server/services/multitenancy/current-site');

// Phase 4b: per-site getSiteUrl override. The url-utils singleton stays
// global, but its `getSiteUrl` reads the active site from
// AsyncLocalStorage at call time.

describe('UNIT: url-utils (Phase 4b multitenancy override)', function () {
    let configStub;

    beforeEach(function () {
        // Pin the config-default URL so the fallback assertion is stable
        // regardless of test machine env. Pin getSubdir to empty string.
        configStub = sinon.stub(config, 'getSiteUrl').returns('http://localhost:2368/');
        sinon.stub(config, 'getSubdir').returns('');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('falls back to config.getSiteUrl when no site is active', function () {
        const url = urlUtils.__getSiteUrl();
        assert.equal(url, 'http://localhost:2368/');
    });

    it('returns per-site URL inside runWithSite (uses sites.host)', async function () {
        const site = {id: 'siteaa00000000000000000a', slug: 'wayland', host: 'wayland.townbrief.com'};
        const url = await runWithSite(site, () => urlUtils.__getSiteUrl());
        // scheme derived from config-default (http here); production swaps to https
        assert.equal(url, 'http://wayland.townbrief.com/');
    });

    it('prefers custom_domain over host when present', async function () {
        const site = {
            id: 'siteaa00000000000000000a',
            slug: 'wayland',
            host: 'wayland.townbrief.com',
            custom_domain: 'waylandpost.org'
        };
        const url = await runWithSite(site, () => urlUtils.__getSiteUrl());
        assert.equal(url, 'http://waylandpost.org/');
    });

    it('appends a relative path argument', async function () {
        const site = {id: 'siteaa00000000000000000a', slug: 'wayland', host: 'wayland.townbrief.com'};
        const url = await runWithSite(site, () => urlUtils.__getSiteUrl('about'));
        assert.equal(url, 'http://wayland.townbrief.com/about');
    });

    it('produces different URLs for different active sites', async function () {
        const siteA = {id: 'aa00000000000000000000aa', slug: 'a', host: 'a.test'};
        const siteB = {id: 'bb00000000000000000000bb', slug: 'b', host: 'b.test'};
        const urlA = await runWithSite(siteA, () => urlUtils.__getSiteUrl());
        const urlB = await runWithSite(siteB, () => urlUtils.__getSiteUrl());
        assert.notEqual(urlA, urlB, 'two active sites must not produce the same URL');
        assert.equal(urlA, 'http://a.test/');
        assert.equal(urlB, 'http://b.test/');
    });
});
