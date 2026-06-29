const assert = require('node:assert/strict');
const sinon = require('sinon');

const WebhookController = require('../../../../../core/server/services/stripe/webhook-controller');
const {getCurrentSiteId, runWithSite} = require('../../../../../core/server/services/multitenancy/current-site');
const db = require('../../../../../core/server/data/db');

// Phase 7: every Stripe webhook is dispatched inside `runWithSite()` so
// downstream services (Bookshelf models, settings cache, urlUtils, mail)
// see the right site. Site resolution: event.metadata.townbrief_site_id
// first, customer DB lookup fallback, drop with 200 if neither yields
// a site.

const SITE_A = 'sitea0000000000000000000';
const SITE_B = 'siteb0000000000000000000';

function mkRes() {
    const res = {writeHead: sinon.spy(), end: sinon.spy()};
    return res;
}

function mkReq(event, signature = 'whsec-sig') {
    return {
        body: Buffer.from(JSON.stringify(event)),
        headers: {'stripe-signature': signature}
    };
}

function mkController({parseWebhook = (() => null), eventServices = {}} = {}) {
    const noopService = {handleEvent: sinon.stub().resolves(), handleSubscriptionEvent: sinon.stub().resolves(), handleInvoiceEvent: sinon.stub().resolves()};
    const c = new WebhookController({
        webhookManager: {parseWebhook},
        checkoutSessionEventService: eventServices.checkout || noopService,
        subscriptionEventService: eventServices.subscription || noopService,
        invoiceEventService: eventServices.invoice || noopService,
        chargeRefundedEventService: eventServices.charge || noopService
    });
    c.configure({webhookCustomerIgnoreList: []});
    return c;
}

describe('UNIT: WebhookController (Phase 7 multitenancy dispatch)', function () {
    afterEach(function () {
        sinon.restore();
    });

    describe('getEventSiteIdFromMetadata', function () {
        const c = mkController();

        it('returns the top-level metadata when present', function () {
            const event = {data: {object: {metadata: {townbrief_site_id: SITE_A}}}};
            assert.equal(c.getEventSiteIdFromMetadata(event), SITE_A);
        });

        it('falls back to invoice.lines[0].metadata', function () {
            const event = {data: {object: {lines: {data: [{metadata: {townbrief_site_id: SITE_B}}]}}}};
            assert.equal(c.getEventSiteIdFromMetadata(event), SITE_B);
        });

        it('returns null when no metadata is present anywhere', function () {
            const event = {data: {object: {customer: 'cus_x', amount: 1000}}};
            assert.equal(c.getEventSiteIdFromMetadata(event), null);
        });

        it('returns null on malformed events', function () {
            assert.equal(c.getEventSiteIdFromMetadata(null), null);
            assert.equal(c.getEventSiteIdFromMetadata({}), null);
            assert.equal(c.getEventSiteIdFromMetadata({data: {}}), null);
        });
    });

    describe('getSiteIdFromCustomerLookup', function () {
        let firstStub;

        beforeEach(function () {
            const chain = {
                innerJoin: sinon.stub().returnsThis(),
                where: sinon.stub().returnsThis(),
                first: (firstStub = sinon.stub())
            };
            sinon.replaceGetter(db, 'knex', () => () => chain);
        });

        it('returns site_id when the customer row joins to a member with site_id', async function () {
            firstStub.resolves({site_id: SITE_A});
            const c = mkController();
            const out = await c.getSiteIdFromCustomerLookup('cus_real');
            assert.equal(out, SITE_A);
        });

        it('returns null when customer is unknown', async function () {
            firstStub.resolves(undefined);
            const c = mkController();
            const out = await c.getSiteIdFromCustomerLookup('cus_ghost');
            assert.equal(out, null);
        });

        it('returns null on null/empty customerId without querying', async function () {
            const c = mkController();
            assert.equal(await c.getSiteIdFromCustomerLookup(null), null);
            assert.equal(await c.getSiteIdFromCustomerLookup(undefined), null);
            assert.equal(await c.getSiteIdFromCustomerLookup(''), null);
            // Stub's `first` was never called, even though we set it up.
            sinon.assert.notCalled(firstStub);
        });

        it('returns null and logs (does not throw) when the DB call rejects', async function () {
            firstStub.rejects(new Error('connection refused'));
            const c = mkController();
            const out = await c.getSiteIdFromCustomerLookup('cus_db_down');
            assert.equal(out, null);
        });
    });

    describe('handle (full dispatch)', function () {
        it('runs handleEvent inside runWithSite when metadata supplies site_id', async function () {
            const event = {
                id: 'evt_1', type: 'customer.subscription.updated',
                data: {object: {metadata: {townbrief_site_id: SITE_A}}}
            };
            const subscriptionService = {handleSubscriptionEvent: sinon.stub().callsFake(() => {
                // While handler runs, the AsyncLocalStorage must carry SITE_A.
                assert.equal(getCurrentSiteId(), SITE_A,
                    'handler must run inside runWithSite scope');
                return Promise.resolve();
            })};
            const c = mkController({
                parseWebhook: () => event,
                eventServices: {subscription: subscriptionService}
            });
            const res = mkRes();
            await c.handle(mkReq(event), res);
            sinon.assert.calledOnce(subscriptionService.handleSubscriptionEvent);
            sinon.assert.calledWith(res.writeHead, 200);
        });

        it('falls back to customer lookup when no metadata', async function () {
            const event = {
                id: 'evt_2', type: 'invoice.payment_succeeded',
                data: {object: {customer: 'cus_real', amount: 500}}
            };
            const invoiceService = {handleInvoiceEvent: sinon.stub().callsFake(() => {
                assert.equal(getCurrentSiteId(), SITE_B);
                return Promise.resolve();
            })};
            const chain = {
                innerJoin: sinon.stub().returnsThis(),
                where: sinon.stub().returnsThis(),
                first: sinon.stub().resolves({site_id: SITE_B})
            };
            sinon.replaceGetter(db, 'knex', () => () => chain);
            const c = mkController({
                parseWebhook: () => event,
                eventServices: {invoice: invoiceService}
            });
            const res = mkRes();
            await c.handle(mkReq(event), res);
            sinon.assert.calledOnce(invoiceService.handleInvoiceEvent);
            sinon.assert.calledWith(res.writeHead, 200);
        });

        it('drops the event with 200 when site cannot be determined', async function () {
            const event = {
                id: 'evt_unknown', type: 'customer.subscription.created',
                data: {object: {customer: 'cus_unknown'}}
            };
            const chain = {
                innerJoin: sinon.stub().returnsThis(),
                where: sinon.stub().returnsThis(),
                first: sinon.stub().resolves(undefined)
            };
            sinon.replaceGetter(db, 'knex', () => () => chain);
            const subscriptionService = {handleSubscriptionEvent: sinon.spy()};
            const c = mkController({
                parseWebhook: () => event,
                eventServices: {subscription: subscriptionService}
            });
            const res = mkRes();
            await c.handle(mkReq(event), res);
            sinon.assert.notCalled(subscriptionService.handleSubscriptionEvent);
            sinon.assert.calledWith(res.writeHead, 200);
        });

        it('different events route to different sites in series', async function () {
            const recorded = [];
            const subscriptionService = {handleSubscriptionEvent: sinon.stub().callsFake(() => {
                recorded.push(getCurrentSiteId());
                return Promise.resolve();
            })};
            const c = mkController({
                parseWebhook: ev => ev, // we'll pass parsed events as bodies
                eventServices: {subscription: subscriptionService}
            });
            const evA = {id: 'a', type: 'customer.subscription.updated',
                data: {object: {metadata: {townbrief_site_id: SITE_A}}}};
            const evB = {id: 'b', type: 'customer.subscription.updated',
                data: {object: {metadata: {townbrief_site_id: SITE_B}}}};
            // override parseWebhook to return whatever we set on req.body.parsed
            c.webhookManager.parseWebhook = sinon.stub().callsFake((body) => JSON.parse(body.toString()));
            await c.handle(mkReq(evA), mkRes());
            await c.handle(mkReq(evB), mkRes());
            assert.deepEqual(recorded, [SITE_A, SITE_B]);
        });
    });
});
