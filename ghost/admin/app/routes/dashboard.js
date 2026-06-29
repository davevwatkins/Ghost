import AdminRoute from 'ghost-admin/routes/admin';
import {inject as service} from '@ember/service';

export default class DashboardRoute extends AdminRoute {
    @service router;

    async beforeModel() {
        this.router.replaceWith('react-fallback', 'analytics');
    }
}
