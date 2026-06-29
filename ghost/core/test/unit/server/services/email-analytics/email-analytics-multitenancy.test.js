const assert = require('node:assert/strict');
const sinon = require('sinon');

// Phase 8b: every Mailgun analytics event is processed inside
// runWithSite() keyed by the originating email's site_id. The lookup
// uses one whereIn query per batch (cached by emailId), so cost is
// O(unique emails in batch) not O(events).

// NOTE on test isolation:
//
// Other tests in the combined mocha run (e.g. cross-site-sso) delete
// the `current-site` and `db` module cache entries in their afterEach.
// email-analytics-service.js lazily caches both as module-level
// singletons (_runWithSite, _db). If those are stale:
//   - _runWithSite sets the ALS context on the OLD instance while the
//     test's getCurrentSiteId reads from the NEW one → scopes diverge.
//   - _db points to the original exports object while sinon.replaceGetter
//     targeted a fresh exports object → stub is invisible to the service.
//
// Fix: beforeEach clears both the service and db module cache entries
// so the service always lazy-loads fresh instances that match what the
// test observes. stubDb() injects a plain object into the cache so the
// service's _db gets our stub (not a real connection) on first access.

const EMAIL_SERVICE_PATH = require.resolve('../../../../../core/server/services/email-analytics/email-analytics-service');
const CURRENT_SITE_PATH = require.resolve('../../../../../core/server/services/multitenancy/current-site');
const DB_PATH = require.resolve('../../../../../core/server/data/db');

const SITE_A = 'sitea0000000000000000000';
const SITE_B = 'siteb0000000000000000000';

function mkService(EmailAnalyticsService, {batchProcessing = false} = {}) {
    return new EmailAnalyticsService({
        config: {get: (key) => key === 'emailAnalytics:batchProcessing' ? batchProcessing : null},
        eventProcessor: {
            handleDelivered: sinon.stub().resolves({memberId: 'm', emailId: 'e'}),
            handleOpened: sinon.stub().resolves({memberId: 'm', emailId: 'e'}),
            handlePermanentFailed: sinon.stub().resolves(null),
            handleTemporaryFailed: sinon.stub().resolves(null),
            handleUnsubscribed: sinon.stub().resolves(null),
            handleComplained: sinon.stub().resolves(null),
            batchGetRecipients: sinon.stub().resolves(new Map()),
            flushBatchedUpdates: sinon.stub().resolves()
        }
    });
}

// Inject a fake db module into the require cache. The service's lazy
// `_db = require('../../data/db')` will pick up this object (not a real
// connection) on its first call after the cache was cleared in beforeEach.
function stubDb(knexFn) {
    require.cache[DB_PATH] = {
        id: DB_PATH, filename: DB_PATH, loaded: true,
        exports: {knex: knexFn}
    };
}

function stubEmailsLookup(siteByEmailId) {
    const rows = Object.entries(siteByEmailId).map(([id, site_id]) => ({id, site_id}));
    const chain = {
        whereIn: sinon.stub().returnsThis(),
        select: sinon.stub().resolves(rows)
    };
    stubDb(() => chain);
    return chain;
}

describe('UNIT: EmailAnalyticsService (Phase 8b multitenancy scope)', function () {
    let EmailAnalyticsService;
    let getCurrentSiteId;

    beforeEach(function () {
        // Clear the service and db cache entries so the service's lazy
        // singletons are re-fetched fresh this test.
        delete require.cache[EMAIL_SERVICE_PATH];
        delete require.cache[DB_PATH];
        EmailAnalyticsService = require(EMAIL_SERVICE_PATH);
        getCurrentSiteId = require(CURRENT_SITE_PATH).getCurrentSiteId;
    });

    afterEach(function () {
        sinon.restore();
        delete require.cache[EMAIL_SERVICE_PATH];
        delete require.cache[DB_PATH];
    });

    it('wraps processEvent in runWithSite scoped to each event\'s email site_id', async function () {
        const service = mkService(EmailAnalyticsService);
        const knexChain = stubEmailsLookup({
            email_a: SITE_A,
            email_b: SITE_B
        });

        const observed = [];
        sinon.stub(service, 'processEvent').callsFake(async (event) => {
            observed.push({emailId: event.emailId, scope: getCurrentSiteId()});
            return {merge: () => {}};
        });

        const events = [
            {emailId: 'email_a', type: 'delivered', timestamp: new Date(), providerId: 'p1', recipientEmail: 'x@a.test'},
            {emailId: 'email_b', type: 'delivered', timestamp: new Date(), providerId: 'p2', recipientEmail: 'x@b.test'},
            {emailId: 'email_a', type: 'opened', timestamp: new Date(), providerId: 'p1', recipientEmail: 'x@a.test'}
        ];
        await service.processEventBatch(events, {merge: () => {}}, {});

        assert.deepEqual(observed, [
            {emailId: 'email_a', scope: SITE_A},
            {emailId: 'email_b', scope: SITE_B},
            {emailId: 'email_a', scope: SITE_A}
        ]);

        sinon.assert.calledOnce(knexChain.select);
        const inListArg = knexChain.whereIn.firstCall.args[1];
        assert.deepEqual([...inListArg].sort(), ['email_a', 'email_b']);
    });

    it('falls back to default site when the DB lookup fails', async function () {
        const service = mkService(EmailAnalyticsService);
        const chain = {
            whereIn: sinon.stub().returnsThis(),
            select: sinon.stub().rejects(new Error('connection refused'))
        };
        stubDb(() => chain);

        let observed = null;
        sinon.stub(service, 'processEvent').callsFake(async () => {
            observed = getCurrentSiteId();
            return {merge: () => {}};
        });

        const events = [{emailId: 'unknown', type: 'delivered', timestamp: new Date(), providerId: 'p1', recipientEmail: 'x@x.test'}];
        await service.processEventBatch(events, {merge: () => {}}, {});

        assert.equal(observed, 'default0000000000000000');
    });

    it('falls back to default site when an event has no emailId', async function () {
        const service = mkService(EmailAnalyticsService);
        stubEmailsLookup({});

        let observed = null;
        sinon.stub(service, 'processEvent').callsFake(async () => {
            observed = getCurrentSiteId();
            return {merge: () => {}};
        });

        const events = [{emailId: undefined, type: 'delivered', timestamp: new Date(), providerId: 'p1', recipientEmail: 'x@x.test'}];
        await service.processEventBatch(events, {merge: () => {}}, {});

        assert.equal(observed, 'default0000000000000000');
    });

    it('does not leak AsyncLocalStorage between events of different sites', async function () {
        const service = mkService(EmailAnalyticsService);
        stubEmailsLookup({a: SITE_A, b: SITE_B});

        sinon.stub(service, 'processEvent').callsFake(async () => ({merge: () => {}}));

        const events = [
            {emailId: 'a', type: 'delivered', timestamp: new Date(), providerId: 'p', recipientEmail: 'x@a.test'},
            {emailId: 'b', type: 'delivered', timestamp: new Date(), providerId: 'p', recipientEmail: 'x@b.test'}
        ];
        await service.processEventBatch(events, {merge: () => {}}, {});

        assert.equal(getCurrentSiteId(), null);
    });

    it('uses the same per-batch cache for repeated emailIds (one DB query)', async function () {
        const service = mkService(EmailAnalyticsService);
        const chain = stubEmailsLookup({shared_email: SITE_A});

        sinon.stub(service, 'processEvent').resolves({merge: () => {}});

        const events = Array.from({length: 5}, () => ({
            emailId: 'shared_email', type: 'delivered',
            timestamp: new Date(), providerId: 'p', recipientEmail: 'x@a.test'
        }));
        await service.processEventBatch(events, {merge: () => {}}, {});

        sinon.assert.calledOnce(chain.select);
    });
});
