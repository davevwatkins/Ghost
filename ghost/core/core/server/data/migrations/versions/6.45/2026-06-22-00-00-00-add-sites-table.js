const {addTable} = require('../../utils');

// TownBrief multitenancy phase 1: the sites table.
// Every other table will gain a site_id column referencing sites.id in phase 2.
module.exports = addTable('sites', {
    id: {type: 'string', maxlength: 24, nullable: false, primary: true},
    slug: {type: 'string', maxlength: 191, nullable: false, unique: true},
    name: {type: 'string', maxlength: 191, nullable: false},
    host: {type: 'string', maxlength: 191, nullable: false, unique: true},
    custom_domain: {type: 'string', maxlength: 191, nullable: true, unique: true},
    status: {type: 'string', maxlength: 50, nullable: false, defaultTo: 'active', validations: {isIn: [['active', 'suspended', 'archived']]}},
    stripe_account_id: {type: 'string', maxlength: 191, nullable: true},
    mailgun_from: {type: 'string', maxlength: 191, nullable: true},
    created_at: {type: 'dateTime', nullable: false},
    updated_at: {type: 'dateTime', nullable: true}
});
