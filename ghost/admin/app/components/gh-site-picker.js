// TownBrief multitenancy Phase 5b: site picker dropdown.
// Sits in the admin top nav; lets superadmins (and users belonging to
// multiple sites) switch between sites by navigating their browser to
// the target site's admin URL.

import Component from '@glimmer/component';
import {action} from '@ember/object';
import {inject as service} from '@ember/service';

export default class GhSitePickerComponent extends Component {
    @service sites;
    @service session;

    constructor() {
        super(...arguments);
        // Only fetch once per app load — the result is cached on the
        // service. Triggers when an authenticated admin views any page.
        if (this.session.isAuthenticated && !this.sites.loaded) {
            this.sites.reload();
        }
    }

    get currentSiteHost() {
        if (typeof window === 'undefined') return null;
        return window.location.host.replace(/:\d+$/, '');
    }

    get currentSite() {
        return this.sites.sites.find(s =>
            s.host === this.currentSiteHost || s.custom_domain === this.currentSiteHost
        );
    }

    @action
    switchTo(site) {
        const url = this.sites.siteAdminUrl(site);
        window.location.href = url;
    }
}
