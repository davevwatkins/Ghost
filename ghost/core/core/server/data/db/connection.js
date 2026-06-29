const _ = require('lodash');
const knex = require('knex');
const os = require('os');

const logging = require('@tryghost/logging');
const config = require('../../../shared/config');

/** @type {knex.Knex} */
let knexInstance;

// @TODO:
// - if you require this file before config file was loaded,
// - then this file is cached and you have no chance to connect to the db anymore
// - bring dynamic into this file (db.connect())
function configure(dbConfig) {
    const client = dbConfig.client;

    if (client === 'sqlite3') {
        // Backwards compatibility with old knex behaviour
        dbConfig.useNullAsDefault = Object.prototype.hasOwnProperty.call(dbConfig, 'useNullAsDefault') ? dbConfig.useNullAsDefault : true;

        // Enables foreign key checks and delete on cascade
        dbConfig.pool = {
            afterCreate(conn, cb) {
                conn.run('PRAGMA foreign_keys = ON', cb);

                // These two are meant to improve performance at the cost of reliability
                // Should be safe for tests. We add them here and leave them on
                if (config.get('env').startsWith('testing')) {
                    conn.run('PRAGMA synchronous = OFF;');
                    conn.run('PRAGMA journal_mode = TRUNCATE;');
                }
            }
        };

        // In the default SQLite test config we set the path to /tmp/ghost-test.db,
        // but this won't work on Windows, so we need to replace the /tmp bit with
        // the Windows temp folder
        const filename = dbConfig.connection.filename;
        if (process.platform === 'win32' && _.isString(filename) && filename.match(/^\/tmp/)) {
            dbConfig.connection.filename = filename.replace(/^\/tmp/, os.tmpdir());
            logging.info(`Ghost DB path: ${dbConfig.connection.filename}`);
        }
    }

    if (client === 'pg') {
        // TownBrief multitenancy: Postgres is the production engine. Phase 1
        // installs RLS using `current_setting('app.site_id', true)` and the
        // host-resolver middleware sets it per-request via `SET LOCAL`.
        // Ghost stores all timestamps as UTC strings in app code, so we pin
        // the session timezone to UTC defensively.
        //
        // pg returns BIGINT (OID 20) and NUMERIC (OID 1700) as strings by
        // default because they can exceed JS Number.MAX_SAFE_INTEGER. Ghost
        // code (esp. the pagination helper, fetchPage plugin, model
        // aggregates) treats COUNT(*) as a JS number — without coercion,
        // every paged endpoint throws "Invalid value, check page, pages,
        // limit and total are numbers". Coerce both globally; if a single
        // counter ever exceeds 2^53 we have bigger problems.
        const pgTypes = require('pg').types;
        pgTypes.setTypeParser(20, val => val === null ? null : parseInt(val, 10));
        pgTypes.setTypeParser(1700, val => val === null ? null : parseFloat(val));

        dbConfig.pool = Object.assign({}, dbConfig.pool, {
            afterCreate(conn, cb) {
                conn.query("SET TIME ZONE 'UTC'", err => cb(err, conn));
            }
        });
    }

    return dbConfig;
}

if (!knexInstance && config.get('database') && config.get('database').client) {
    knexInstance = knex(configure(config.get('database')));

    // TownBrief multitenancy Phase 1.5b: stamp the active site_id onto
    // every Postgres connection at acquire time, reset on release. The
    // RLS policies installed in Phase 2c then hard-filter every query
    // to the active site (system scope / NULL falls through the OR-NULL
    // clause). Done as a monkey-patch on the client's
    // acquireConnection/releaseConnection so it composes transparently
    // with Bookshelf, knex-migrator, raw db.knex callers, and any
    // existing transaction code — no `transacting:` thread required.
    //
    // Lazy-require the multitenancy service to dodge boot ordering
    // (connection.js is loaded extremely early; services/multitenancy
    // is a sibling module that may not be require-able yet).
    if (knexInstance.client.config.client === 'pg') {
        let _getCurrentSiteId;
        function getCurrentSiteId() {
            if (!_getCurrentSiteId) {
                try {
                    _getCurrentSiteId = require('../../services/multitenancy/current-site').getCurrentSiteId;
                } catch (e) {
                    return null;
                }
            }
            return _getCurrentSiteId();
        }

        const client = knexInstance.client;
        const origAcquire = client.acquireConnection.bind(client);
        client.acquireConnection = async function siteScopedAcquire() {
            const conn = await origAcquire();
            const siteId = getCurrentSiteId();
            await new Promise((resolve, reject) => {
                // `set_config(name, value, is_local=false)` sets a session-
                // level GUC; empty string clears it. Always set so reused
                // connections never leak the prior request's siteId.
                conn.query("SELECT set_config('app.site_id', $1, false)", [siteId || ''], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return conn;
        };

        const origRelease = client.releaseConnection.bind(client);
        client.releaseConnection = async function siteScopedRelease(conn) {
            try {
                await new Promise((resolve) => {
                    conn.query("SELECT set_config('app.site_id', '', false)", [], () => resolve());
                });
            } catch (e) {
                // swallow — release should never throw
            }
            return origRelease(conn);
        };
    }
}

module.exports = knexInstance;
