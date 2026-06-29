// TownBrief multitenancy Phase 5b: Ember service that fetches the list
// of sites the current user can switch to (via /ghost/api/admin/sites/).
// Used by the gh-site-picker component to render the top-bar dropdown.
//
// Caches the result for the lifetime of the admin session — site lists
// change rarely (only when a superadmin creates a new site or one is
// suspended). Add explicit `reload()` if a switch-site flow ever needs
// to refresh on demand.

import Service, {inject as service} from '@ember/service';
import {tracked} from '@glimmer/tracking';
import {task} from 'ember-concurrency';
import {inject} from 'ghost-admin/decorators/inject';

export default class SitesService extends Service {
    @inject config;
    @service ajax;
    @service ghostPaths;

    @tracked sites = [];
    @tracked isSuperadmin = false;
    @tracked loaded = false;

    fetchSitesTask = task(async () => {
        const url = this.ghostPaths.url.api('sites');
        try {
            const response = await this.ajax.request(url);
            this.sites = response.sites || [];
            this.isSuperadmin = !!(response.meta && response.meta.is_superadmin);
            this.loaded = true;
        } catch (err) {
            // 403 is the expected response for unauthenticated requests
            // or non-admin users; treat as "no sites available".
            this.sites = [];
            this.isSuperadmin = false;
            this.loaded = true;
        }
        return this.sites;
    });

    get canSwitchSites() {
        // Only show the picker if there's more than one site OR the user
        // is a superadmin (who could legitimately want to create more).
        return this.loaded && (this.sites.length > 1 || this.isSuperadmin);
    }

    siteAdminUrl(site) {
        // Switching = navigating the browser to the chosen site's admin.
        // Use HTTPS in production, the configured scheme otherwise (the
        // backend Phase 4b derives the scheme from config.getSiteUrl).
        const host = site.custom_domain || site.host;
        const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
        return `${scheme}://${host}/ghost/`;
    }

    reload() {
        return this.fetchSitesTask.perform();
    }
}
