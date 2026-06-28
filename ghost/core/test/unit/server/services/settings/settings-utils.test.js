const assert = require('node:assert/strict');
const sinon = require('sinon');

describe('Unit: services/settings/settings-utils', function () {
    describe('isSecretSetting', function () {
        const {isSecretSetting} = require('../../../../../core/server/services/settings/settings-utils');

        it('identifies settings containing "secret" as secret', function () {
            assert.equal(isSecretSetting({key: 'admin_secret'}), true);
            assert.equal(isSecretSetting({key: 'stripe_secret_key'}), true);
        });

        it('identifies settings containing "api_key" as secret', function () {
            assert.equal(isSecretSetting({key: 'ghost_admin_api_key'}), true);
            assert.equal(isSecretSetting({key: 'content_api_key'}), true);
        });

        it('does not flag non-secret settings', function () {
            assert.equal(isSecretSetting({key: 'title'}), false);
            assert.equal(isSecretSetting({key: 'description'}), false);
            assert.equal(isSecretSetting({key: 'navigation'}), false);
        });
    });

    describe('hideValueIfSecret', function () {
        const {hideValueIfSecret, obfuscatedSetting} = require('../../../../../core/server/services/settings/settings-utils');

        it('obfuscates the value of secret settings', function () {
            const result = hideValueIfSecret({key: 'admin_api_key', value: 'real-key-value'});
            assert.equal(result.value, obfuscatedSetting);
        });

        it('does not obfuscate non-secret settings', function () {
            const result = hideValueIfSecret({key: 'title', value: 'My Blog'});
            assert.equal(result.value, 'My Blog');
        });
    });

    describe('getOrGenerateSiteUuid', function () {
        const config = require('../../../../../core/shared/config');
        const logging = require('@tryghost/logging');
        const {getOrGenerateSiteUuid} = require('../../../../../core/server/services/settings/settings-utils');
        
        let configGetStub;
        let loggingInfoStub;
        let loggingErrorStub;

        beforeEach(function () {
            configGetStub = sinon.stub(config, 'get');
            loggingInfoStub = sinon.stub(logging, 'info');
            loggingErrorStub = sinon.stub(logging, 'error');
            // Reset the cached UUID before each test
            getOrGenerateSiteUuid._reset();
        });

        afterEach(function () {
            sinon.restore();
        });

        it('uses configured UUID when valid UUID is provided', function () {
            const testUuid = '550e8400-e29b-41d4-a716-446655440000';
            configGetStub.withArgs('site_uuid').returns(testUuid);

            const result = getOrGenerateSiteUuid();

            assert.equal(result, testUuid.toLowerCase());
            sinon.assert.calledOnce(configGetStub);
            sinon.assert.calledOnce(loggingInfoStub);
        });

        it('generates new UUID when config value is not a valid UUID', function () {
            configGetStub.withArgs('site_uuid').returns('not-a-valid-uuid');

            const result = getOrGenerateSiteUuid();

            // Should be a valid UUID v4
            assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            sinon.assert.calledOnce(configGetStub);
            sinon.assert.calledOnce(loggingInfoStub);
        });

        it('generates new UUID when config value is null', function () {
            configGetStub.withArgs('site_uuid').returns(null);

            const result = getOrGenerateSiteUuid();

            // Should be a valid UUID v4
            assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            sinon.assert.calledOnce(configGetStub);
            sinon.assert.calledOnce(loggingInfoStub);
        });

        it('generates new UUID when config value is undefined', function () {
            configGetStub.withArgs('site_uuid').returns(undefined);

            const result = getOrGenerateSiteUuid();

            // Should be a valid UUID v4
            assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            sinon.assert.calledOnce(configGetStub);
            sinon.assert.calledOnce(loggingInfoStub);
        });

        it('generates new UUID when config throws an error', function () {
            const testError = new Error('Config error');
            configGetStub.withArgs('site_uuid').throws(testError);

            const result = getOrGenerateSiteUuid();

            // Should be a valid UUID v4
            assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            sinon.assert.calledOnce(configGetStub);
            sinon.assert.calledOnce(loggingErrorStub);
        });

        it('converts uppercase UUID to lowercase', function () {
            const testUuid = '550E8400-E29B-41D4-A716-446655440000';
            configGetStub.withArgs('site_uuid').returns(testUuid);

            const result = getOrGenerateSiteUuid();

            assert.equal(result, testUuid.toLowerCase());
            assert.equal(result, '550e8400-e29b-41d4-a716-446655440000');
        });

        it('handles mixed case UUID correctly', function () {
            const testUuid = '550e8400-E29B-41d4-A716-446655440000';
            configGetStub.withArgs('site_uuid').returns(testUuid);

            const result = getOrGenerateSiteUuid();

            assert.equal(result, testUuid.toLowerCase());
            assert.equal(result, '550e8400-e29b-41d4-a716-446655440000');
        });

        it('returns the configured UUID on every call when config is set', function () {
            // When config.site_uuid is set, the function is deterministic: the
            // same configured value is returned each call (no caching needed
            // because the source is itself stable).
            const testUuid = '550e8400-e29b-41d4-a716-446655440000';
            configGetStub.withArgs('site_uuid').returns(testUuid);

            const result1 = getOrGenerateSiteUuid();
            const result2 = getOrGenerateSiteUuid();

            assert.equal(result1, testUuid.toLowerCase());
            assert.equal(result2, testUuid.toLowerCase());
        });

        it('generates a FRESH UUID on every call when config is not set (no cross-site cache)', function () {
            // Multitenancy contract: one Ghost process serves many sites, so
            // memoising a single UUID at module scope would hand the same
            // value to every site. Each call must yield a new UUID.
            configGetStub.withArgs('site_uuid').returns(null);

            const result1 = getOrGenerateSiteUuid();
            const result2 = getOrGenerateSiteUuid();
            const result3 = getOrGenerateSiteUuid();

            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
            assert.match(result1, uuidRegex);
            assert.match(result2, uuidRegex);
            assert.match(result3, uuidRegex);
            assert.notEqual(result1, result2, 'consecutive calls must not return the same UUID');
            assert.notEqual(result2, result3, 'consecutive calls must not return the same UUID');
            assert.notEqual(result1, result3, 'consecutive calls must not return the same UUID');
        });
    });
});