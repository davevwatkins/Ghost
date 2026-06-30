const debug = require('@tryghost/debug')('models:base:multitenancy');
const errors = require('@tryghost/errors');

const schema = require('../../../data/schema');
const {getCurrentSiteId} = require('../../../services/multitenancy/current-site');

// TownBrief multitenancy Phase 3: Bookshelf plugin that auto-scopes every
// model query to the currently-active site_id.
//
//   - on `fetching` / `fetching:collection`: adds `WHERE site_id = ?` to the
//     query, scoped to the AsyncLocalStorage-bound active site.
//   - on `creating`: stamps `site_id` on the new row.
//   - on `updating` / `destroying`: refuses to modify rows belonging to a
//     different site (defense in depth — the WHERE scope already filters
//     them out, but a malicious or buggy code path that bypassed the fetch
//     scope would still be blocked here).
//
// Opt-outs:
//   - Tables in `UNSCOPED_TABLES` (sites, brute) are not site-scoped.
//   - Passing `options.allowCrossSite = true` bypasses scoping for that call
//     — for superadmin tooling, migrations, scheduled fan-outs that
//     legitimately need cross-site access. Use sparingly.
//   - When there is no active site (background jobs, REPL, boot), scoping
//     is skipped — the AsyncLocalStorage simply has no value. This is the
//     deliberate "deny-by-default in HTTP scope, allow in system scope"
//     contract. The Postgres GUC + RLS policies in Phase 2b are the
//     load-bearing backstop for code that runs outside any clear scope.

// Tables that don't carry site_id. Must match the exclusions in schema.js +
// the Phase 2 migration. Update both places if you add another exemption.
const UNSCOPED_TABLES = new Set(['sites', 'brute']);

// The default site id — must match the schema.js column default for
// `site_id` AND the seed default site row. Used for system-scope writes
// (background jobs, boot-time inserts) that run outside any active site.
const DEFAULT_SITE_ID = 'default0000000000000000';

function tableHasSiteId(tableName) {
    if (UNSCOPED_TABLES.has(tableName)) return false;
    const cols = schema.tables[tableName];
    return !!(cols && cols.site_id);
}

function isAllowCrossSite(options) {
    if (!options) return false;
    if (options.allowCrossSite) return true;
    // Ghost's filterOptions whitelist strips top-level options that aren't
    // in `permittedOptions`. `context` always survives the filter, so
    // callers in static methods like `findAll`, `findPage` should set
    // `{context: {allowCrossSite: true}}` to opt out of scoping.
    if (options.context && options.context.allowCrossSite) return true;
    return false;
}

function shouldScope(model, options) {
    if (!model || !model.tableName) return false;
    if (isAllowCrossSite(options)) return false;
    if (!tableHasSiteId(model.tableName)) return false;
    return true;
}

module.exports = function multitenancyPlugin(Bookshelf) {
    const proto = Bookshelf.Model.prototype;
    const originalInitializeEvents = proto.initializeEvents;

    Bookshelf.Model = Bookshelf.Model.extend({
        // Chain onto the existing initializeEvents (defined by events.js)
        // rather than overriding `initialize`. base/index.js calls
        // `this.initializeEvents()` once per model instance, which now also
        // wires our multitenancy hooks alongside the standard ones.
        initializeEvents: function initializeEvents() {
            if (originalInitializeEvents) {
                originalInitializeEvents.apply(this, arguments);
            }
            this.on('fetching', this.onFetchingSiteScoped);
            this.on('fetching:collection', this.onFetchingSiteScoped);
            this.on('counting', this.onFetchingSiteScoped);
            this.on('creating', this.onCreatingSiteScoped);
            this.on('updating', this.onUpdatingSiteScoped);
            this.on('destroying', this.onDestroyingSiteScoped);
        },

        onFetchingSiteScoped: function onFetchingSiteScoped(model, columns, options) {
            if (!shouldScope(this, options)) return;
            // Prefer options.siteIdForImport over AsyncLocalStorage — Bluebird's
            // mapSeries (used by Bookshelf's triggerThen) doesn't propagate Node.js
            // async context, so getCurrentSiteId() may return null here during imports.
            const siteId = (options && options.siteIdForImport) || getCurrentSiteId();
            if (!siteId) {
                debug(`No active site for ${this.tableName} fetch — letting through (system scope)`);
                return;
            }
            if (!options || !options.query) {
                // Defensive: if Bookshelf didn't pass options.query (rare —
                // older Bookshelf versions don't), fall back to a no-op
                // rather than silently leaking. The plugin is designed for
                // current Bookshelf which always provides it.
                debug(`No options.query on ${this.tableName} fetch hook — cannot scope`);
                return;
            }
            // CTE-based queries (e.g. the members link-click-events fetch) override
            // their FROM to a CTE that doesn't expose this table's site_id column, so
            // a qualified `<tableName>.site_id` filter would reference a table that
            // isn't in the FROM clause and Postgres errors with "missing FROM-clause
            // entry for table ...". (The FROM override is applied AFTER this fetch
            // hook fires, so we cannot detect it from options.query here — but the
            // caller flags such queries with options.useCTE.) Those CTEs select from
            // the underlying table, which RLS already scopes by current_site_id(), so
            // the explicit WHERE is both impossible and unnecessary — skip it and let
            // RLS (the documented load-bearing backstop) enforce isolation. As a
            // fallback, also skip when the FROM is already overridden at hook time.
            const single = options.query._single;
            const fromTable = single && typeof single.table === 'string' ? single.table : null;
            if (options.useCTE || (fromTable && fromTable !== this.tableName)) {
                debug(`Skipping explicit site scope for ${this.tableName} (CTE/custom FROM); RLS enforces isolation`);
                return;
            }
            // Qualified column name so joins don't ambiguate `site_id`.
            const col = `${this.tableName}.site_id`;
            options.query.where(col, siteId);
            debug(`Scoped ${this.tableName} fetch to site_id=${siteId}`);
        },

        onCreatingSiteScoped: function onCreatingSiteScoped(model, attrs, options) {
            if (!shouldScope(this, options)) return;
            // System scope (no active site): stamp the default site id so
            // background jobs, boot-time inserts, and migrations land in
            // the default site bucket. Without this, Bookshelf serializes
            // `site_id: null` in the INSERT, which violates the column's
            // NOT NULL constraint (the column's DB default only fires
            // when the column is OMITTED, not when it's NULL).
            //
            // Prefer options.siteIdForImport over AsyncLocalStorage: Bookshelf's
            // triggerThen() uses bluebird.mapSeries() which does NOT propagate
            // Node.js AsyncLocalStorage context, so getCurrentSiteId() may return
            // null here even when a valid site is being imported. data-importer.js
            // threads the explicit siteId through modelOptions.siteIdForImport to
            // give this hook a reliable fallback.
            const siteId = (options && options.siteIdForImport) || getCurrentSiteId() || DEFAULT_SITE_ID;
            // Always stamp the resolved site_id, even if the caller passed
            // a different one. This is the load-bearing tenant-isolation
            // guarantee in HTTP scope; and the system-scope fallback to
            // default site for background work.
            if (model.get('site_id') && model.get('site_id') !== siteId) {
                debug(`Overriding caller-supplied site_id ${model.get('site_id')} -> ${siteId} on ${this.tableName} insert`);
            }
            model.set('site_id', siteId);
        },

        onUpdatingSiteScoped: function onUpdatingSiteScoped(model, attrs, options) {
            if (!shouldScope(this, options)) return;
            const siteId = getCurrentSiteId();
            if (!siteId) return;
            const rowSiteId = model.get('site_id') || (model.previous && model.previous('site_id'));
            if (rowSiteId && rowSiteId !== siteId) {
                throw new errors.NotFoundError({
                    message: `Cannot update ${this.tableName} row from a different site`,
                    context: `row site_id=${rowSiteId}, active site_id=${siteId}`
                });
            }
            // Prevent callers from re-targeting the row to another site.
            if (attrs && 'site_id' in attrs && attrs.site_id !== siteId) {
                throw new errors.NotFoundError({
                    message: `Cannot reassign ${this.tableName} row to a different site`,
                    context: `attempted site_id=${attrs.site_id}, active site_id=${siteId}`
                });
            }
        },

        onDestroyingSiteScoped: function onDestroyingSiteScoped(model, options) {
            if (!shouldScope(this, options)) return;
            const siteId = getCurrentSiteId();
            if (!siteId) return;
            const rowSiteId = model.get('site_id') || (model.previous && model.previous('site_id'));
            if (rowSiteId && rowSiteId !== siteId) {
                throw new errors.NotFoundError({
                    message: `Cannot destroy ${this.tableName} row from a different site`,
                    context: `row site_id=${rowSiteId}, active site_id=${siteId}`
                });
            }
        }
    });
};
