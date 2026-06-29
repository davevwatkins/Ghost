const assert = require('node:assert/strict');
const SettingsPathManager = require('../../../../../core/server/services/route-settings/settings-path-manager');

describe('Settings Path Manager', function () {
    it('throws when paths parameter is not provided', function () {
        assert.throws(() => {
            new SettingsPathManager({
                paths: [],
                type: 'routes'
            });
        }, /paths values/g);
    });

    describe('getDefaultFilePath', function () {
        it('returns default file path based on routes configuration', function (){
            const settingsPathManager = new SettingsPathManager({
                paths: ['/content/settings', '/content/data'],
                type: 'routes'
            });

            const path = settingsPathManager.getDefaultFilePath();

            assert.equal(path, '/content/settings/routes.yaml');
        });

        it('returns default file path based on redirects configuration', function (){
            const settingsPathManager = new SettingsPathManager({
                paths: ['/content/data', '/content/settings'],
                type: 'redirects'
            });

            const path = settingsPathManager.getDefaultFilePath();

            assert.equal(path, '/content/data/redirects.yaml');
        });

        it('returns default file path based on redirects configuration with json extension', function (){
            const settingsPathManager = new SettingsPathManager({
                paths: ['/content/data', '/content/settings'],
                type: 'redirects',
                extensions: ['json', 'yaml']
            });

            const path = settingsPathManager.getDefaultFilePath();

            assert.equal(path, '/content/data/redirects.json');
        });
    });

    describe('getBackupFilePath', function () {
        it('returns a path to store a backup', function (){
            const settingsPathManager = new SettingsPathManager({
                paths: ['/content/data', '/content/settings'],
                type: 'routes',
                extensions: ['yaml']
            });

            const path = settingsPathManager.getBackupFilePath();

            assert.match(path, /\/content\/data\/routes-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.yaml/);
        });
    });

    // TownBrief multitenancy Phase 4c4: per-site routes.yaml override.
    describe('getPerSiteFilePathIfExists (Phase 4c4)', function () {
        const fs = require('node:fs');
        const os = require('node:os');
        const realPath = require('node:path');
        let tmpRoot;

        beforeEach(function () {
            tmpRoot = fs.mkdtempSync(realPath.join(os.tmpdir(), 'townbrief-routes-test-'));
            fs.mkdirSync(realPath.join(tmpRoot, 'settings'), {recursive: true});
            fs.mkdirSync(realPath.join(tmpRoot, 'sites', 'wayland'), {recursive: true});
        });

        afterEach(function () {
            try { fs.rmSync(tmpRoot, {recursive: true, force: true}); } catch (e) { /* ignore */ }
        });

        function mkPathManager() {
            return new SettingsPathManager({
                type: 'routes',
                paths: [realPath.join(tmpRoot, 'settings')]
            });
        }

        it('returns null when no per-site file exists', function () {
            const pm = mkPathManager();
            assert.equal(pm.getPerSiteFilePathIfExists('wayland', tmpRoot), null);
        });

        it('returns the per-site path when content/sites/<slug>/routes.yaml exists', function () {
            const target = realPath.join(tmpRoot, 'sites', 'wayland', 'routes.yaml');
            fs.writeFileSync(target, 'routes:\n  /: {}\n');
            const pm = mkPathManager();
            assert.equal(pm.getPerSiteFilePathIfExists('wayland', tmpRoot), target);
        });

        it('returns null when siteSlug is missing', function () {
            const pm = mkPathManager();
            assert.equal(pm.getPerSiteFilePathIfExists(null, tmpRoot), null);
            assert.equal(pm.getPerSiteFilePathIfExists(undefined, tmpRoot), null);
            assert.equal(pm.getPerSiteFilePathIfExists('', tmpRoot), null);
        });

        it('returns null when contentRoot is missing', function () {
            const pm = mkPathManager();
            assert.equal(pm.getPerSiteFilePathIfExists('wayland', null), null);
            assert.equal(pm.getPerSiteFilePathIfExists('wayland', ''), null);
        });

        it('does not affect getDefaultFilePath', function () {
            const pm = mkPathManager();
            const expected = realPath.join(tmpRoot, 'settings', 'routes.yaml');
            assert.equal(pm.getDefaultFilePath(), expected);
        });
    });
});
