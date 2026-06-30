'use strict';

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const {Pool} = require('pg');
const path = require('path');

const PORT = process.env.PORT || 3001;

// County membership map — aggregator slug (without "news") -> county name, town slug -> county name
const COUNTY_LOOKUP = Object.assign({},
    // Aggregators
    {middlesexcounty:'Middlesex',norfolkcounty:'Norfolk',essexcounty:'Essex',
     suffolkcounty:'Suffolk',worcestercounty:'Worcester',plymouthcounty:'Plymouth',
     barnstablecounty:'Barnstable',berkshirecounty:'Berkshire',bristolcounty:'Bristol',
     dukescounty:'Dukes',franklincounty:'Franklin',hampdencounty:'Hampden',
     hampshirecounty:'Hampshire',nantucketcounty:'Nantucket'},
    // Middlesex towns
    Object.fromEntries(['acton','arlington','ashby','ashland','ayer','bedford','belmont',
     'billerica','boxborough','burlington','cambridge','carlisle','chelmsford','concord',
     'dracut','dunstable','everett','framingham','groton','holliston','hopkinton','hudson',
     'lexington','lincoln','littleton','lowell','malden','marlborough','maynard','medford',
     'melrose','natick','newton','north-reading','pepperell','reading','sherborn','shirley',
     'somerville','stoneham','stow','sudbury','tewksbury','townsend','tyngsborough','wakefield',
     'waltham','watertown','wayland','westford','weston','wilmington','winchester','woburn'
    ].map(s => [s,'Middlesex'])),
    // Norfolk towns
    Object.fromEntries(['avon','bellingham','braintree','brookline','canton','cohasset',
     'dedham','dover','foxborough','franklin','holbrook','medfield','medway','millis','milton',
     'needham','norfolk','norwood','plainville','quincy','randolph','sharon','stoughton',
     'walpole','wellesley','westwood','weymouth','wrentham'
    ].map(s => [s,'Norfolk'])),
    // Essex towns
    Object.fromEntries(['amesbury','andover','beverly','boxford','danvers','essex','georgetown',
     'gloucester','groveland','hamilton','haverhill','ipswich','lawrence','lynn','lynnfield',
     'manchester-by-the-sea','marblehead','merrimac','methuen','middleton','nahant','newbury',
     'newburyport','north-andover','peabody','rockport','rowley','salem','salisbury','saugus',
     'swampscott','topsfield','wenham','west-newbury'
    ].map(s => [s,'Essex'])),
    // Plymouth towns
    Object.fromEntries(['abington','bridgewater','brockton','carver','duxbury','east-bridgewater',
     'halifax','hanover','hanson','hingham','hull','kingston','lakeville','marion','marshfield',
     'mattapoisett','middleborough','norwell','pembroke','plymouth','plympton','rochester',
     'rockland','scituate','wareham','west-bridgewater','whitman'
    ].map(s => [s,'Plymouth'])),
    // Suffolk towns
    Object.fromEntries(['boston','chelsea','revere','winthrop'].map(s => [s,'Suffolk'])),
    // Barnstable towns
    Object.fromEntries(['barnstable','bourne','brewster','chatham','dennis','eastham','falmouth',
     'harwich','mashpee','orleans','provincetown','sandwich','truro','wellfleet','yarmouth'
    ].map(s => [s,'Barnstable'])),
    // Worcester towns
    Object.fromEntries(['ashburnham','athol','auburn','barre','berlin','blackstone','bolton',
     'boylston','brookfield','charlton','clinton','douglas','dudley','east-brookfield',
     'fitchburg','gardner','grafton','hardwick','harvard','holden','hopedale','hubbardston',
     'lancaster','leicester','leominster','lunenburg','mendon','milford','millbury','millville',
     'new-braintree','north-brookfield','northborough','northbridge','oakham','oxford','paxton',
     'petersham','phillipston','princeton','royalston','rutland','shrewsbury','southborough',
     'southbridge','spencer','sterling','sturbridge','sutton','templeton','upton','uxbridge',
     'warren','webster','west-boylston','west-brookfield','westborough','westminster',
     'winchendon','worcester'
    ].map(s => [s,'Worcester'])),
    // Bristol towns
    Object.fromEntries(['acushnet','attleboro','berkley','dartmouth','dighton','easton',
     'fairhaven','fall-river','freetown','mansfield','new-bedford','north-attleborough',
     'norton','raynham','rehoboth','seekonk','somerset','swansea','taunton','westport'
    ].map(s => [s,'Bristol'])),
    // Franklin towns
    Object.fromEntries(['ashfield','bernardston','buckland','charlemont','colrain','conway',
     'deerfield','erving','gill','greenfield','hawley','heath','leverett','leyden','monroe',
     'montague','new-salem','northfield','orange','rowe','shelburne','shutesbury','sunderland',
     'warwick','wendell','whately'
    ].map(s => [s,'Franklin'])),
    // Hampden towns
    Object.fromEntries(['agawam','blandford','brimfield','chester','chicopee','east-longmeadow',
     'granville','hampden','holland','holyoke','longmeadow','ludlow','monson','montgomery',
     'palmer','russell','southwick','springfield','tolland','wales','west-springfield',
     'westfield','wilbraham'
    ].map(s => [s,'Hampden'])),
    // Hampshire towns
    Object.fromEntries(['amherst','belchertown','chesterfield','cummington','easthampton',
     'goshen','granby','hadley','hatfield','huntington','middlefield','northampton','pelham',
     'plainfield','south-hadley','southampton','ware','westhampton','williamsburg','worthington'
    ].map(s => [s,'Hampshire'])),
    // Berkshire towns
    Object.fromEntries(['adams','alford','becket','cheshire','clarksburg','dalton','egremont',
     'florida','great-barrington','hancock','hinsdale','lanesborough','lee','lenox','monterey',
     'mount-washington','new-ashford','new-marlborough','north-adams','otis','peru','pittsfield',
     'richmond','sandisfield','savoy','sheffield','stockbridge','tyringham','washington',
     'west-stockbridge','williamstown','windsor'
    ].map(s => [s,'Berkshire'])),
    // Dukes towns
    Object.fromEntries(['aquinnah','chilmark','edgartown','gosnold','oak-bluffs','tisbury',
     'west-tisbury'
    ].map(s => [s,'Dukes'])),
    // Nantucket
    {nantucket: 'Nantucket'}
);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'townbrief2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'townbrief-superadmin-dev-secret';
const GHOST_ADMIN_HOST = process.env.GHOST_ADMIN_HOST || 'middlesexcounty.localtest.me';

const pool = new Pool({
    host: process.env.PGHOST || 'ghost-dev-postgres',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'ghost_dev',
    user: process.env.PGUSER || 'ghost',
    password: process.env.PGPASSWORD || 'ghostpassword'
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({extended: true}));
app.use(session({
    store: new PgSession({pool, tableName: 'superadmin_sessions', createTableIfMissing: true}),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {maxAge: 30 * 24 * 60 * 60 * 1000}
}));

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session.authenticated) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({error: 'Not authenticated'});
    // Preserve where the user was headed (e.g. an /sso/<slug> auto-login) so we
    // can return there after a single superadmin login — this is what makes
    // "log in once, visit any site" work.
    res.redirect('/login?return=' + encodeURIComponent(req.originalUrl));
}

// Login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    const ret = (typeof req.body.return === 'string' && req.body.return) || '/';
    // Only allow local same-app redirects (no protocol-relative // or absolute URLs).
    const safeReturn = /^\/(?!\/)/.test(ret) ? ret : '/';
    if (req.body.username === ADMIN_USER && req.body.password === ADMIN_PASS) {
        req.session.authenticated = true;
        res.redirect(safeReturn);
    } else {
        res.redirect('/login?error=1&return=' + encodeURIComponent(safeReturn));
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// Static files (authenticated)
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// ─── API ────────────────────────────────────────────────────────────────────

// GET /api/sites — all sites with stats
app.get('/api/sites', requireAuth, async (req, res) => {
    try {
        const {rows} = await pool.query(`
            SELECT
                s.id, s.slug, s.name, s.created_at,
                COUNT(p.id) FILTER (WHERE p.status = 'published' AND p.type = 'post') AS published,
                COUNT(p.id) FILTER (WHERE p.status = 'draft'     AND p.type = 'post') AS draft,
                COUNT(p.id) FILTER (WHERE p.type = 'page') AS pages,
                MAX(p.updated_at) AS last_activity,
                MAX(CASE WHEN st.key = 'title'       THEN st.value END) AS title,
                MAX(CASE WHEN st.key = 'description' THEN st.value END) AS description,
                MAX(CASE WHEN st.key = 'logo'        THEN st.value END) AS logo,
                MAX(CASE WHEN st.key = 'accent_color' THEN st.value END) AS accent_color
            FROM sites s
            LEFT JOIN posts p ON p.site_id = s.id
            LEFT JOIN settings st ON st.site_id = s.id AND st.key IN ('title','description','logo','accent_color')
            WHERE s.slug != 'default'
            GROUP BY s.id, s.slug, s.name, s.created_at
            ORDER BY s.name
        `);
        const sites = rows.map(r => ({...r, county: COUNTY_LOOKUP[r.slug] || null}));
        res.json({sites, ghostAdminHost: GHOST_ADMIN_HOST});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// GET /api/content — cross-site post browser
app.get('/api/content', requireAuth, async (req, res) => {
    try {
        const {q, site, county, status, type, page} = req.query;
        const offset = (parseInt(page || 1) - 1) * 40;
        const params = [];
        const conditions = ["s.slug != 'default'", "p.type = $1"];
        params.push(type || 'post');

        if (site) {
            params.push(site); conditions.push(`s.slug = $${params.length}`);
        } else if (county) {
            const slugs = Object.entries(COUNTY_LOOKUP).filter(([,c]) => c === county).map(([s]) => s);
            if (slugs.length) { params.push(slugs); conditions.push(`s.slug = ANY($${params.length})`); }
        }
        if (status && status !== 'all') { params.push(status); conditions.push(`p.status = $${params.length}`); }
        if (q) { params.push(`%${q}%`); conditions.push(`(p.title ILIKE $${params.length} OR p.custom_excerpt ILIKE $${params.length})`); }

        const where = conditions.join(' AND ');
        params.push(40, offset);

        const {rows} = await pool.query(`
            SELECT
                p.id, p.title, p.slug, p.status, p.type,
                p.published_at, p.updated_at, p.created_at,
                p.custom_excerpt,
                s.slug AS site_slug, s.name AS site_name
            FROM posts p
            JOIN sites s ON p.site_id = s.id
            WHERE ${where}
            ORDER BY p.updated_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);

        // total count
        const countParams = params.slice(0, -2);
        const {rows: countRows} = await pool.query(
            `SELECT COUNT(*) FROM posts p JOIN sites s ON p.site_id = s.id WHERE ${where}`,
            countParams
        );

        const posts = rows.map(r => ({...r, county: COUNTY_LOOKUP[r.site_slug] || null}));
        res.json({posts, total: parseInt(countRows[0].count)});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// GET /api/members — cross-site member browser (so the launcher fully replaces the
// native admin's Members section, which 404s on the stale React build).
app.get('/api/members', requireAuth, async (req, res) => {
    try {
        const {q, site, county, status, page} = req.query;
        const offset = (parseInt(page || 1) - 1) * 40;
        const params = [];
        const conditions = ["s.slug != 'default'"];

        if (site) {
            params.push(site); conditions.push(`s.slug = $${params.length}`);
        } else if (county) {
            const slugs = Object.entries(COUNTY_LOOKUP).filter(([,c]) => c === county).map(([sl]) => sl);
            if (slugs.length) { params.push(slugs); conditions.push(`s.slug = ANY($${params.length})`); }
        }
        if (status && status !== 'all') { params.push(status); conditions.push(`m.status = $${params.length}`); }
        if (q) { params.push(`%${q}%`); conditions.push(`(m.email ILIKE $${params.length} OR m.name ILIKE $${params.length})`); }

        const where = conditions.join(' AND ');
        params.push(40, offset);

        const {rows} = await pool.query(`
            SELECT m.id, m.email, m.name, m.status, m.created_at,
                   s.slug AS site_slug, s.name AS site_name
            FROM members m
            JOIN sites s ON m.site_id = s.id
            WHERE ${where}
            ORDER BY m.created_at DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `, params);

        const countParams = params.slice(0, -2);
        const {rows: countRows} = await pool.query(
            `SELECT COUNT(*) FROM members m JOIN sites s ON m.site_id = s.id WHERE ${where}`,
            countParams
        );

        const members = rows.map(r => ({...r, county: COUNTY_LOOKUP[r.site_slug] || null}));
        res.json({members, total: parseInt(countRows[0].count)});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// GET /api/sites/:slug/settings
app.get('/api/sites/:slug/settings', requireAuth, async (req, res) => {
    try {
        const {rows} = await pool.query(`
            SELECT st.key, st.value
            FROM settings st
            JOIN sites s ON st.site_id = s.id
            WHERE s.slug = $1
              AND st.key IN ('title','description','logo','cover_image','icon',
                             'accent_color','navigation','secondary_navigation',
                             'timezone','lang','codeinjection_head','codeinjection_foot',
                             'og_title','og_description','twitter_title','twitter_description',
                             'members_signup_access','default_content_visibility')
            ORDER BY st.key
        `, [req.params.slug]);

        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        res.json(settings);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// PATCH /api/sites/:slug/settings
app.patch('/api/sites/:slug/settings', requireAuth, async (req, res) => {
    const ALLOWED = new Set(['title','description','logo','cover_image','icon',
        'accent_color','navigation','secondary_navigation','timezone','lang',
        'codeinjection_head','codeinjection_foot','og_title','og_description',
        'twitter_title','twitter_description','members_signup_access','default_content_visibility']);
    try {
        const updates = Object.entries(req.body).filter(([k]) => ALLOWED.has(k));
        if (!updates.length) return res.json({updated: 0});

        for (const [key, value] of updates) {
            await pool.query(`
                UPDATE settings SET value = $1, updated_at = NOW()
                WHERE site_id = (SELECT id FROM sites WHERE slug = $2) AND key = $3
            `, [value, req.params.slug, key]);
        }
        res.json({updated: updates.length});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// GET /api/pipeline — per-site health / import status
app.get('/api/pipeline', requireAuth, async (req, res) => {
    try {
        const {rows} = await pool.query(`
            SELECT
                s.slug, s.name,
                COUNT(p.id) FILTER (WHERE p.type = 'post' AND p.status = 'published') AS published,
                COUNT(p.id) FILTER (WHERE p.type = 'post' AND p.status = 'draft')     AS draft,
                MAX(CASE WHEN st.key = 'title' THEN st.value END) AS settings_title,
                MAX(CASE WHEN st.key = 'logo'  THEN st.value END) AS settings_logo
            FROM sites s
            LEFT JOIN posts p    ON p.site_id  = s.id
            LEFT JOIN settings st ON st.site_id = s.id AND st.key IN ('title','logo')
            WHERE s.slug != 'default'
            GROUP BY s.slug, s.name
            ORDER BY s.name
        `);

        const sites = rows.map((r) => {
            const issues = [];
            if (!r.settings_title || r.settings_title === r.name) issues.push('title may be wrong');
            if (!r.settings_logo) issues.push('no logo set');
            if (parseInt(r.published) === 0) issues.push('no published posts');
            const county = COUNTY_LOOKUP[r.slug] || null;
            return {...r, county, issues, health: issues.length === 0 ? 'ok' : issues.length === 1 ? 'warn' : 'error'};
        });

        res.json({sites});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// ─── SSO ─────────────────────────────────────────────────────────────────────
// Signs a cross-site SSO token using the same algorithm as
// ghost/core/core/server/services/multitenancy/cross-site-sso.js so the
// Ghost redeem endpoint can verify it without modification.

const DEFAULT_SITE_ID = 'default0000000000000000';
let _ssoSecret = null;
let _ssoUserId = null;

async function getSsoMaterial() {
    if (_ssoSecret && _ssoUserId) return {secret: _ssoSecret, userId: _ssoUserId};
    const [{rows: sRows}, {rows: uRows}] = await Promise.all([
        pool.query(
            `SELECT value FROM settings WHERE site_id = $1 AND key = 'admin_session_secret' LIMIT 1`,
            [DEFAULT_SITE_ID]
        ),
        pool.query(`SELECT id FROM users WHERE is_superadmin = true LIMIT 1`)
    ]);
    if (!sRows.length) throw new Error('admin_session_secret not in default site settings');
    if (!uRows.length) throw new Error('No superadmin user found');
    _ssoSecret = sRows[0].value;
    _ssoUserId = uRows[0].id;
    return {secret: _ssoSecret, userId: _ssoUserId};
}

function buildSsoToken(payload, secret) {
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
    return `${b64}.${mac}`;
}

// GET /sso/:slug — mint a cross-site SSO token and redirect the browser
// to the target site's redeem endpoint. Ghost sets the session cookie there.
app.get('/sso/:slug', requireAuth, async (req, res) => {
    try {
        const {slug} = req.params;
        const {rows} = await pool.query(
            `SELECT id FROM sites WHERE slug = $1 LIMIT 1`, [slug]
        );
        if (!rows.length) return res.status(404).send('Site not found');
        const targetSiteId = rows[0].id;

        const {secret, userId} = await getSsoMaterial();
        const exp = Date.now() + 60_000;
        const nonce = crypto.randomBytes(16).toString('base64url');
        const token = buildSsoToken({userId, targetSiteId, exp, nonce}, secret);

        let redeemUrl = `http://${slug}.localtest.me/ghost/api/admin/session/sso-redeem?token=${encodeURIComponent(token)}`;
        // Optional deep-link target (e.g. /ghost/#/members) so the launcher can
        // drop you straight into a section of the target site's admin.
        if (req.query.next) {
            redeemUrl += `&next=${encodeURIComponent(req.query.next)}`;
        }
        res.redirect(302, redeemUrl);
    } catch (err) {
        res.status(500).send(`SSO error: ${err.message}`);
    }
});

// GET /api/me
app.get('/api/me', requireAuth, (req, res) => {
    res.json({authenticated: true, user: ADMIN_USER, ghostAdminHost: GHOST_ADMIN_HOST});
});

app.listen(PORT, () => {
    console.log(`TownBrief superadmin listening on :${PORT}`);
});
