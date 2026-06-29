import AuthenticatedRoute from 'ghost-admin/routes/authenticated';
import {inject} from 'ghost-admin/decorators/inject';
import {inject as service} from '@ember/service';

export default class HomeRoute extends AuthenticatedRoute {
    @inject config;
    @service feature;
    @service onboarding;
    @service router;
    @service session;

    async beforeModel(transition) {
        await super.beforeModel(...arguments);

        if (transition.to?.queryParams?.firstStart === 'true') {
            transition.abort();
            if (this.session.user?.isOwnerOnly) {
                await this.onboarding.startChecklist();
            }
            window.location.hash = '/setup/onboarding?returnTo=/dashboard';
            return;
        }

        if (this.session.user?.isAdmin) {
            this.router.transitionTo('react-fallback', 'analytics');
        } else if (this.session.user?.isContributor) {
            this.router.transitionTo('posts', {queryParams: {type: 'published'}});
        } else {
            this.router.transitionTo('site');
        }
    }
}
