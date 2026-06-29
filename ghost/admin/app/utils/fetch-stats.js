import config from 'ghost-admin/config/environment';
import {prefixAssetUrl} from 'ghost-admin/utils/asset-base';

export default async function fetchStats() {
    if (window['@tryghost/stats']) {
        return window['@tryghost/stats'];
    }

    const baseUrl = prefixAssetUrl('assets/stats/');
    const url = new URL(`${baseUrl}${config.statsFilename}?v=${config.statsHash}`);

    let statsModule;
    if (url.protocol === 'http:') {
        statsModule = await import(`http://${url.host}${url.pathname}${url.search}`);
    } else {
        statsModule = await import(`https://${url.host}${url.pathname}${url.search}`);
    }

    window['@tryghost/stats'] = statsModule;
    return window['@tryghost/stats'];
}
