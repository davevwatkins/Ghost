const assert = require('node:assert/strict');
const sinon = require('sinon');

// Phase 4c4e: RouterManager must record every generator registration in
// _routerParams and expose them via getRouterParams() so per-site
// UrlService instances can replay them after initDynamicRouting().

describe('UNIT: RouterManager.getRouterParams() (Phase 4c4e)', function () {
    let RouterManager;
    let RM_PATH;

    before(function () {
        RM_PATH = require.resolve('../../../../../core/frontend/services/routing/router-manager');
        RouterManager = require(RM_PATH);
    });

    function makeStubRegistry() {
        return {
            resetAllRouters: sinon.stub(),
            resetAllRoutes: sinon.stub(),
            setRouter: sinon.stub(),
            getAllRoutes: sinon.stub().returns({})
        };
    }

    function makeManager() {
        const rm = new RouterManager({registry: makeStubRegistry()});
        // wire a stub urlService so routerCreated() can call onRouterAddedType
        rm.urlService = {onRouterAddedType: sinon.stub()};
        return rm;
    }

    function makeRouter({identifier, filter, resourceType, permalink}) {
        return {
            identifier,
            filter,
            getResourceType: () => resourceType,
            getPermalinks: () => ({getValue: () => permalink})
        };
    }

    it('starts with an empty params list', function () {
        const rm = makeManager();
        assert.deepEqual(rm.getRouterParams(), []);
    });

    it('records params when routerCreated() fires for a resource router', function () {
        const rm = makeManager();
        rm.routerCreated(makeRouter({
            identifier: 'col-1',
            filter: null,
            resourceType: 'posts',
            permalink: '/:slug/'
        }));

        const params = rm.getRouterParams();
        assert.equal(params.length, 1);
        assert.deepEqual(params[0], {
            identifier: 'col-1',
            filter: null,
            resourceType: 'posts',
            permalink: '/:slug/'
        });
    });

    it('skips routers that have no permalinks (static routes)', function () {
        const rm = makeManager();
        rm.routerCreated({identifier: 'static-r', filter: null, getPermalinks: () => null});
        rm.routerCreated(null);
        assert.deepEqual(rm.getRouterParams(), []);
    });

    it('accumulates params across multiple routerCreated() calls', function () {
        const rm = makeManager();
        rm.routerCreated(makeRouter({identifier: 'col', filter: null, resourceType: 'posts', permalink: '/:slug/'}));
        rm.routerCreated(makeRouter({identifier: 'tag', filter: null, resourceType: 'tags', permalink: '/tag/:slug/'}));
        rm.routerCreated(makeRouter({identifier: 'pag', filter: 'page:true', resourceType: 'posts', permalink: '/:slug/'}));

        const params = rm.getRouterParams();
        assert.equal(params.length, 3);
        assert.equal(params[1].identifier, 'tag');
        assert.equal(params[2].filter, 'page:true');
    });

    it('returns a defensive copy (mutations do not affect internal state)', function () {
        const rm = makeManager();
        rm.routerCreated(makeRouter({identifier: 'col', filter: null, resourceType: 'posts', permalink: '/:slug/'}));

        const snap1 = rm.getRouterParams();
        snap1.push({identifier: 'injected'});

        const snap2 = rm.getRouterParams();
        assert.equal(snap2.length, 1, 'internal list should not be mutated by caller');
    });

    it('forwards params to urlService.onRouterAddedType()', function () {
        const rm = makeManager();
        rm.routerCreated(makeRouter({identifier: 'col', filter: null, resourceType: 'posts', permalink: '/:slug/'}));

        sinon.assert.calledOnce(rm.urlService.onRouterAddedType);
        const [id, filter, type, perm] = rm.urlService.onRouterAddedType.firstCall.args;
        assert.equal(id, 'col');
        assert.equal(filter, null);
        assert.equal(type, 'posts');
        assert.equal(perm, '/:slug/');
    });
});
