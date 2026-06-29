# TownBrief multitenancy — testing patterns

Phase 10 work. The pre-multitenant Ghost test suite assumes a single
tenant; many tests just work in the fork because:

- The Phase 1.6 boot hook seeds a default site row (id
  `default0000000000000000`).
- The Phase 3 Bookshelf plugin treats system scope (no active site)
  as "see everything" — tests without site context still pass.
- The Phase 2 column default stamps `site_id = 'default0000000000000000'`
  on all fixture inserts, so existing fixture-based tests live on
  the default site.

Tests that actually EXERCISE multitenancy (cross-site isolation,
per-site config, per-site users) opt into a real site scope using
the helpers in `ghost/core/test/utils/multitenancy-utils.js`.

## Helpers

### `withSite(siteOrId, testFn)`

Mocha test wrapper. Use when the test body needs to run inside
`runWithSite()` of a specific site.

```js
const {withSite, fakeSite} = require('../utils/multitenancy-utils');
const SITE_A = fakeSite('wayland');

it('reads posts from the active site',
    withSite(SITE_A, async function () {
        const posts = await models.Post.findAll();
        // Phase 3 plugin scopes this to SITE_A automatically.
    })
);
```

### `fakeSite(slug)`

Builds a minimal site object suitable for unit tests that don't touch
the DB but DO exercise multitenancy code paths (settings cache,
url utils, theme picker). The id is a 24-char string derived from
the slug.

### `createTestSite({slug, name?, host?, seedAuthModel?})`

Integration helper — creates a real `sites` row + seeds 118 default
settings + (by default) clones the auth model (roles + permissions
+ permissions_roles) from the default site. Wraps in a transaction.

Pair with `destroyTestSite(id)` for cleanup in `afterAll`/`after`.

### `assertScopedTo(siteId, fn)`

Defensive — runs the body inside `runWithSite` AND asserts the
AsyncLocalStorage was actually set. Catches accidental
mis-wrapping when refactoring tests.

## When to retrofit a test

A test needs retrofitting if **any** of these is true:

1. It tests cross-tenant isolation directly — verifying that site A
   can't see site B's data.
2. It relies on side effects of Phase 4a–e (settings cache,
   urlUtils, theme cache, mail config) and the side effect should
   differ per site.
3. It exercises code that runs `runWithSite` internally (the
   site-resolver middleware, batch-sending-service, stripe webhook
   handler, email-analytics processEvent) — assertions need to be
   aware of which scope they're running in.
4. It exercises code that previously assumed a singleton (URL
   service lookups, ActiveTheme.get, settings lookup) and the
   singleton has been split per-site.

Tests that ONLY hit pure utility functions, schema validation, or
fixture data assertions usually don't need retrofitting — they pass
on the default site as before.

## Categories of existing tests

The full pre-fork test suite is hundreds of files. Categories by
retrofit need:

| Category | Example file | Retrofit needed? |
|---|---|---|
| Pure unit (filter, validators, helpers) | `unit/server/lib/*` | No |
| Model schema + validations | `unit/server/models/post.test.js` | Optional — adds value if testing per-site uniqueness |
| Service business logic (members, stripe, email) | `unit/server/services/*` | Yes when service composes with settings/url/mail |
| Integration tests (e2e API, DB) | `integration/**` | Yes when test sequence creates data that should be site-scoped |
| End-to-end browser (Playwright) | `e2e/**` | Outside scope — runs against full booted Ghost where multitenancy is already proven |

## Migration pattern

Smallest viable retrofit for a service test:

```diff
+const {withSite, fakeSite} = require('../../../utils/multitenancy-utils');
+const SITE_A = fakeSite('test-a');

 describe('MyService', function () {
-    it('does the thing', async function () {
+    it('does the thing', withSite(SITE_A, async function () {
         // existing test body, unchanged
-    });
+    }));
 });
```

For tests that already use sinon/mocks and don't need DB scoping,
`fakeSite` + `withSite` is enough. For tests that hit the DB,
`createTestSite` produces a real row.

## What's NOT yet retrofitted

Honestly: most of the pre-fork suite. The helpers above are the
load-bearing piece — every future PR that touches a multitenancy-
related code path should add `withSite()` to the affected tests.
A full backfill of existing tests is not in scope; the multitenancy
fork's 75+ new tests cover the new code paths, and the existing
suite continues to pass under system scope (the deliberate "no
active site = no scoping" contract from Phase 3).
