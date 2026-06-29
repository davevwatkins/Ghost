const {createModelClass} = require('./utils');
const BatchSendingService = require('../../../../../core/server/services/email-service/batch-sending-service');
const sinon = require('sinon');
const assert = require('node:assert/strict');
const logging = require('@tryghost/logging');
const {getCurrentSiteId} = require('../../../../../core/server/services/multitenancy/current-site');

// Phase 8: newsletter batch sending runs inside runWithSite() keyed by
// the email row's site_id, so downstream code (mail service `from`,
// urlUtils for links, settings cache for title) reads the right site.

describe('UNIT: BatchSendingService (Phase 8 multitenancy scope)', function () {
    beforeEach(function () {
        sinon.stub(logging, 'error');
        sinon.stub(logging, 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('runs sendEmail inside runWithSite scoped to email.site_id', async function () {
        const SITE_A = 'sitea0000000000000000000';
        const Email = createModelClass({
            findOne: {
                status: 'pending',
                site_id: SITE_A,
                email_count: 1
            }
        });
        const service = new BatchSendingService({models: {Email}});

        let observedSiteId = null;
        sinon.stub(service, 'sendEmail').callsFake(() => {
            // The active site_id at sendEmail-time must match the email's.
            observedSiteId = getCurrentSiteId();
            return Promise.resolve();
        });

        await service.emailJob({emailId: '123'});
        assert.equal(observedSiteId, SITE_A);
    });

    it('falls back to default site when email row has no site_id', async function () {
        const Email = createModelClass({
            findOne: {
                status: 'pending',
                site_id: null,
                email_count: 1
            }
        });
        const service = new BatchSendingService({models: {Email}});

        let observedSiteId = null;
        sinon.stub(service, 'sendEmail').callsFake(() => {
            observedSiteId = getCurrentSiteId();
            return Promise.resolve();
        });

        await service.emailJob({emailId: '456'});
        assert.equal(observedSiteId, 'default0000000000000000');
    });

    it('does not leak the active site to the next job', async function () {
        const SITE_A = 'sitea0000000000000000000';
        const SITE_B = 'siteb0000000000000000000';
        const sites = [SITE_A, SITE_B];
        const observed = [];

        for (const siteId of sites) {
            const Email = createModelClass({
                findOne: {
                    status: 'pending',
                    site_id: siteId,
                    email_count: 1
                }
            });
            const service = new BatchSendingService({models: {Email}});
            sinon.stub(service, 'sendEmail').callsFake(() => {
                observed.push(getCurrentSiteId());
                return Promise.resolve();
            });
            await service.emailJob({emailId: `email-${siteId}`});
            // Outside the runWithSite scope, getCurrentSiteId() must be null.
            assert.equal(getCurrentSiteId(), null,
                'AsyncLocalStorage must not leak between jobs');
            sinon.restore();
            sinon.stub(logging, 'error');
            sinon.stub(logging, 'info');
        }
        assert.deepEqual(observed, [SITE_A, SITE_B]);
    });

    it('still scopes when sendEmail throws', async function () {
        const SITE_A = 'sitea0000000000000000000';
        const Email = createModelClass({
            findOne: {
                status: 'pending',
                site_id: SITE_A,
                email_count: 1
            }
        });
        const service = new BatchSendingService({
            models: {Email},
            AFTER_RETRY_CONFIG: {maxRetries: 1, maxTime: 100, sleep: 1}
        });

        let observedSiteId = null;
        sinon.stub(service, 'sendEmail').callsFake(() => {
            observedSiteId = getCurrentSiteId();
            return Promise.reject(new Error('Mailgun is down'));
        });

        await service.emailJob({emailId: '789'});
        assert.equal(observedSiteId, SITE_A);
    });
});
