// TownBrief multitenancy Phase 5b: hook for the admin site picker.
// Fetches /ghost/api/admin/sites/ — the Phase 5a endpoint returns the
// list of sites the current user can switch to plus an is_superadmin
// flag. The site picker dropdown in the React UserMenu calls this.

import {createQuery} from '../utils/api/hooks';

export interface SiteEntry {
    id: string;
    slug: string;
    name: string;
    host: string;
    custom_domain: string | null;
    status: string;
}

export interface SitesResponseType {
    sites: SiteEntry[];
    meta: {
        is_superadmin: boolean;
    };
}

const dataType = 'SitesResponseType';

// Ghost's API framework wraps the controller's return value under the
// `docName` ('sites'), producing `{sites: [{sites: [...rows...], meta:
// {...}}], meta: {...}}`. Unwrap to the shape the React UI expects.
// (The top-level `meta` is correct; the inner sites array is what we
// need to flatten out of the wrapper object.)
export const useBrowseAvailableSites = createQuery<SitesResponseType>({
    dataType,
    path: '/sites/',
    returnData: (raw: unknown): SitesResponseType => {
        const r = raw as {sites?: Array<{sites?: SiteEntry[]} | SiteEntry>; meta?: {is_superadmin?: boolean}};
        const outer = r?.sites ?? [];
        // If outer[0] looks like a wrapper ({sites: [...]}), unwrap; else
        // assume the response is already flat (forward-compat with a
        // future serializer fix).
        const wrapped = outer[0] as {sites?: SiteEntry[]} | undefined;
        const sites: SiteEntry[] = (wrapped && Array.isArray(wrapped.sites))
            ? wrapped.sites
            : (outer as SiteEntry[]);
        return {
            sites,
            meta: {is_superadmin: !!(r?.meta?.is_superadmin)}
        };
    }
});

// Build the admin URL of a target site. Scheme matches the current
// browser location (so http in dev, https in prod). Custom domain
// wins over `host` when present.
export function adminUrlForSite(site: SiteEntry): string {
    const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';
    const target = site.custom_domain || site.host;
    return `${scheme}://${target}/ghost/`;
}

// Phase 5d: navigate to a target site with cross-site SSO. Mints a
// one-time token on the origin site, then redirects the browser to
// the target host's redeem endpoint which establishes a verified
// session on that host and 303s to /ghost/.
//
// Falls back to a plain navigate (the picker's original behavior) if
// the mint fails — e.g. the API is older than Phase 5d, or the user
// somehow lost superadmin in between mounting the picker and clicking.
export async function navigateToSiteWithSSO(site: SiteEntry): Promise<void> {
    try {
        const resp = await fetch('/ghost/api/admin/session/sso-token', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            credentials: 'include',
            body: JSON.stringify({site_id: site.id})
        });
        if (resp.ok) {
            const {redirect_url} = await resp.json();
            if (redirect_url) {
                window.location.href = redirect_url;
                return;
            }
        }
    } catch (e) {
        // Fall through to plain navigate.
    }
    window.location.href = adminUrlForSite(site);
}
