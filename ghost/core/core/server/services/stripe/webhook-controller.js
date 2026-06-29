const logging = require('@tryghost/logging');

// TownBrief multitenancy Phase 7: when a Stripe webhook fires, we dispatch
// the rest of the request through `runWithSite()` so downstream services
// (Bookshelf model auto-scoping, settings cache, urlUtils, mail) see the
// right site. The site is resolved from `event.data.object.metadata
// .townbrief_site_id` (stamped by Phase 4d2 on every outbound Stripe
// payload). For events Stripe sends on existing entities where we never
// stamped the metadata, we fall back to looking up the customer id in
// `members_stripe_customers` joined to `members.site_id`.
//
// Lazy require so the controller is testable without booting the world.
let _runWithSite;
let _db;
function runWithSite(...args) {
    if (!_runWithSite) {
        _runWithSite = require('../multitenancy/current-site').runWithSite;
    }
    return _runWithSite(...args);
}
function db() {
    if (!_db) _db = require('../../data/db');
    return _db;
}

module.exports = class WebhookController {
    /**
     * @param {object} deps
     * @param {import('./webhook-manager')} deps.webhookManager
     * @param {import('./services/webhook/checkout-session-event-service')} deps.checkoutSessionEventService
     * @param {import('./services/webhook/subscription-event-service')} deps.subscriptionEventService
     * @param {import('./services/webhook/invoice-event-service')} deps.invoiceEventService
     * @param {import('./services/webhook/charge-refunded-event-service')} deps.chargeRefundedEventService
     */
    constructor(deps) {
        this.checkoutSessionEventService = deps.checkoutSessionEventService;
        this.subscriptionEventService = deps.subscriptionEventService;
        this.invoiceEventService = deps.invoiceEventService;
        this.chargeRefundedEventService = deps.chargeRefundedEventService;
        this.webhookManager = deps.webhookManager;
        this.handlers = {
            'customer.subscription.deleted': this.subscriptionEvent,
            'customer.subscription.updated': this.subscriptionEvent,
            'customer.subscription.created': this.subscriptionEvent,
            'invoice.payment_succeeded': this.invoiceEvent,
            'checkout.session.completed': this.checkoutSessionEvent,
            'charge.refunded': this.chargeRefundedEvent
        };
    }

    /**
     * @param {object} config
     * @param {string[]} config.webhookCustomerIgnoreList
     */
    configure({webhookCustomerIgnoreList = []}) {
        this.webhookCustomerIgnoreSet = new Set(
            webhookCustomerIgnoreList.filter(Boolean)
        );
    }

    /**
     * Phase 7: pull the site_id from the event's metadata (Phase 4d2 stamps
     * `townbrief_site_id` on every outbound payload). Looks across the
     * common shapes Stripe uses — top-level metadata, subscription_data
     * metadata (echoed back on subscription events), invoice line item
     * metadata. Returns null if no metadata is present anywhere.
     * @param {import('stripe').Stripe.Event} event
     * @returns {string | null}
     */
    getEventSiteIdFromMetadata(event) {
        const obj = event?.data?.object;
        if (!obj) return null;
        // checkout session / subscription / charge: top-level metadata
        if (obj.metadata?.townbrief_site_id) {
            return obj.metadata.townbrief_site_id;
        }
        // invoice: subscription metadata isn't on the invoice, but the
        // invoice has line items; first line's metadata is typically the
        // subscription's. The Stripe SDK normalises `lines.data`.
        const lineMeta = obj.lines?.data?.[0]?.metadata?.townbrief_site_id;
        if (lineMeta) return lineMeta;
        return null;
    }

    /**
     * Phase 7 fallback: when metadata isn't present (event for a pre-
     * Phase 4d2 customer, or an event type Stripe doesn't echo our
     * metadata on), look up the customer in our DB. Members have
     * `site_id` (Phase 2) and `members_stripe_customers` ties Stripe
     * customer ids back to members.
     * @param {string} customerId
     * @returns {Promise<string|null>}
     */
    async getSiteIdFromCustomerLookup(customerId) {
        if (!customerId) return null;
        try {
            const row = await db().knex('members_stripe_customers')
                .innerJoin('members', 'members_stripe_customers.member_id', 'members.id')
                .where('members_stripe_customers.customer_id', customerId)
                .first('members.site_id');
            return row ? row.site_id : null;
        } catch (err) {
            logging.warn(`getSiteIdFromCustomerLookup failed for customer ${customerId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Resolve which site an event belongs to. Tries metadata first
     * (Phase 4d2 stamps it on everything we create), then falls back to
     * the customer table.
     * @param {import('stripe').Stripe.Event} event
     * @returns {Promise<string|null>}
     */
    async resolveSiteIdForEvent(event) {
        const fromMeta = this.getEventSiteIdFromMetadata(event);
        if (fromMeta) return fromMeta;
        const customerId = this.getEventCustomerId(event);
        return this.getSiteIdFromCustomerLookup(customerId);
    }

    /**
     * @param {import('stripe').Stripe.Event} event
     * @returns {string | null}
     */
    getEventCustomerId(event) {
        const customer = event?.data?.object?.customer;
        if (typeof customer === 'string') {
            return customer;
        }

        if (customer && typeof customer.id === 'string') {
            return customer.id;
        }

        return null;
    }

    /**
     * @param {import('stripe').Stripe.Event} event
     * @returns {boolean}
     */
    shouldIgnoreEvent(event, customerId) {
        if (event.type !== 'customer.subscription.updated') {
            return false;
        }

        return typeof customerId === 'string' && this.webhookCustomerIgnoreSet?.has(customerId) === true;
    }

    /**
     * Handles a Stripe webhook event.
     * - Parses the webhook event
     * - Delegates the event to the appropriate handler
     * - Returns a 200 response to Stripe to confirm receipt of the event, or an error response if the event is not handled or if an error occurs
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @returns {Promise<void>}
     */
    async handle(req, res) {
        if (!req.body || !req.headers['stripe-signature']) {
            res.writeHead(400);
            return res.end();
        }
        let event;
        try {
            event = this.webhookManager.parseWebhook(req.body, req.headers['stripe-signature']);
        } catch (err) {
            logging.error(err);
            res.writeHead(401);
            return res.end();
        }

        const customerId = this.getEventCustomerId(event);
        if (this.shouldIgnoreEvent(event, customerId)) {
            logging.info(`Ignoring webhook ${event.type} for customer ${customerId} based on stripeWebhookCustomerIgnoreList config.`);

            res.writeHead(200);
            return res.end();
        }

        logging.info(`Handling webhook ${event.type}`);

        // TownBrief Phase 7: resolve the site this event belongs to and
        // dispatch the rest of the processing inside a runWithSite() scope.
        // If we can't find a site (no metadata + no matching customer),
        // log + drop with 200 — better than processing under the wrong
        // site context, and Stripe won't retry on 200.
        let siteId;
        try {
            siteId = await this.resolveSiteIdForEvent(event);
        } catch (err) {
            logging.error(`Failed to resolve site for webhook ${event.type}`, err);
            res.writeHead(500);
            return res.end();
        }

        if (!siteId) {
            logging.warn(`Dropping webhook ${event.type} (id=${event.id}) — no townbrief_site_id metadata and no matching customer`);
            res.writeHead(200);
            return res.end();
        }

        try {
            await runWithSite({id: siteId}, () => this.handleEvent(event));
            res.writeHead(200);
            res.end();
        } catch (err) {
            logging.error(`Error handling webhook ${event.type}`, err);
            res.writeHead(err.statusCode || 500);
            res.end();
        }
    }

    /**
     * Accepts a webhook's event payload and delegates it to the appropriate handler based on the event type
     * @private
     * @param {import('stripe').Stripe.Event} event
     * @returns {Promise<void>}
     */
    async handleEvent(event) {
        if (!this.handlers[event.type]) {
            return;
        }

        await this.handlers[event.type].call(this, event.data.object);
    }

    /**
     * Delegates any `customer.subscription.*` events to the `subscriptionEventService`
     * @param {import('stripe').Stripe.Subscription} subscription
     * @private
     */
    async subscriptionEvent(subscription) {
        await this.subscriptionEventService.handleSubscriptionEvent(subscription);
    }

    /**
     * Delegates any `invoice.*` events to the `invoiceEventService`
     * @param {import('stripe').Stripe.Invoice} invoice
     * @private
     */
    async invoiceEvent(invoice) {
        await this.invoiceEventService.handleInvoiceEvent(invoice);
    }

    /**
     * Delegates any `checkout.session.*` events to the `checkoutSessionEventService`
     * @param {import('stripe').Stripe.Checkout.Session} session
     * @private
     */
    async checkoutSessionEvent(session) {
        await this.checkoutSessionEventService.handleEvent(session);
    }

    /**
     * Delegates `charge.refunded` events to the `chargeRefundedEventService`
     * @param {import('stripe').Stripe.Charge} charge
     * @private
     */
    async chargeRefundedEvent(charge) {
        await this.chargeRefundedEventService.handleEvent(charge);
    }
};
