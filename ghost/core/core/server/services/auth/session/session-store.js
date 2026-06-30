const {Store} = require('express-session');
// TownBrief multitenancy: a session is keyed by a globally-unique session_id, so
// its lookup/removal MUST NOT be scoped to a tenant. The `sessions` table is
// site-scoped (RLS + the model-scoping plugin), so if the ACTIVE site context is
// the wrong tenant when these run — e.g. concurrent requests from other town tabs,
// or the session middleware running before the host-resolver sets the context —
// the row is hidden, `req.user` is never set, and authorizeAdminApi returns 403
// (admin bounces to signin → no nav). runWithoutSite() clears the active-site
// context (GUC empty → RLS "no scope = all rows") so the row is always found by id.
const {runWithoutSite} = require('../../multitenancy/current-site');

module.exports = class SessionStore extends Store {
    constructor(SessionModel) {
        super();
        this.SessionModel = SessionModel;
    }

    destroy(sid, callback) {
        runWithoutSite(() => this.SessionModel.destroy({session_id: sid}))
            .then(() => {
                callback(null);
            })
            .catch(callback);
    }

    get(sid, callback) {
        runWithoutSite(() => this.SessionModel.findOne({session_id: sid}))
            .then((model) => {
                if (!model) {
                    return callback(null, null);
                }
                callback(null, model.get('session_data'));
            })
            .catch(callback);
    }

    set(sid, sessionData, callback) {
        // NOT wrapped: a new session must be stamped with the active site_id
        // (the request that creates it runs in the correct site context). The
        // upsert keys on session_id, so an existing row keeps its site_id.
        this.SessionModel
            .upsert({session_data: sessionData}, {session_id: sid})
            .then(() => {
                callback(null);
            })
            .catch(callback);
    }

    clear(callback) {
        runWithoutSite(() => this.SessionModel.destroyAll())
            .then(() => {
                callback(null);
            })
            .catch(callback);
    }
};
