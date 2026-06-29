import Component from '@glimmer/component';
import fetchStats from 'ghost-admin/utils/fetch-stats';
import {inject as service} from '@ember/service';
import {task} from 'ember-concurrency';
import {tracked} from '@glimmer/tracking';

export default class GhAdminXStatsComponent extends Component {
    @service feature;
    @service stateBridge;

    @tracked AdminXApp = null;

    constructor(owner, args) {
        super(owner, args);
        this.loadStatsTask.perform();
    }

    @task({restartable: false})
    *loadStatsTask() {
        try {
            const statsModule = yield fetchStats();
            this.AdminXApp = statsModule?.AdminXApp;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('Failed to load stats app:', e);
        }
    }

    get frameworkProps() {
        const stateBridge = this.stateBridge;
        return {
            ghostVersion: '',
            externalNavigate: (link) => {
                const route = link.route || '';
                window.location.hash = route.startsWith('/') ? route : `/${route}`;
            },
            unsplashConfig: {
                Authorization: '',
                'Accept-Version': '1',
                'Content-Type': 'application/json',
                'App-Pragma': 'no-cache',
                'X-Unsplash-Cache': true
            },
            sentryDSN: null,
            onUpdate: (dataType, response) => stateBridge.onUpdate(dataType, response),
            onInvalidate: dataType => stateBridge.onInvalidate(dataType),
            onDelete: (dataType, id) => stateBridge.onDelete(dataType, id)
        };
    }

    get designSystemProps() {
        return {
            darkMode: this.feature.nightShift || false,
            fetchKoenigLexical: null
        };
    }
}
