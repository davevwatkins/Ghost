const crypto = require('crypto');
const validator = require('@tryghost/validator');
const config = require('../../../shared/config');
const logging = require('@tryghost/logging');

// The string returned when a setting is set as write-only
const obfuscatedSetting = '••••••••';

/**
 * @description // The function used to decide whether a setting is write-only
 * @param {Object} setting setting record
 * @param {string} setting.key
 * @returns {boolean}
 */
function isSecretSetting(setting) {
    return /secret|api_key/.test(setting.key);
}

/**
 * @description The function that obfuscates a write-only setting
 * @param {Object} setting setting record
 * @param {string} setting.value
 * @param {string} setting.key
 * @returns {Object} settings record with obfuscated value if it's a secret
 */
function hideValueIfSecret(setting) {
    if (setting.value && isSecretSetting(setting)) {
        return {...setting, value: obfuscatedSetting};
    }
    return setting;
}

/**
 * @description Get or generate a site UUID, used for seeding the site_uuid setting.
 * Uses the configured site_uuid if valid, otherwise generates a fresh random UUID.
 * To get the `site_uuid` setting, use `settingsCache.get('site_uuid')` instead.
 *
 * TownBrief multitenancy: this function used to memoise a single UUID at the
 * module/process level. Because one Ghost process serves many sites, that cache
 * handed the SAME uuid to every site that asked — breaking Tinybird analytics
 * isolation. The cache is removed so a fresh UUID is generated on each call.
 * `config.site_uuid` (if set) is still honoured; in a multitenant install it
 * effectively pins only one site's value, which is the intended semantic.
 *
 * @returns {string} lowercase UUID
 */
function getOrGenerateSiteUuid() {
    try {
        const configuredSiteUuid = config.get('site_uuid');
        if (configuredSiteUuid && validator.isUUID(configuredSiteUuid)) {
            const value = configuredSiteUuid.toLowerCase();
            logging.info(`Setting site_uuid to configured value: ${value}`);
            return value;
        }
        const value = crypto.randomUUID();
        logging.info(`Configured site_uuid was not found or invalid. Setting site_uuid to a new value: ${value}`);
        return value;
    } catch (error) {
        logging.error('Error getting site UUID from config. Setting site_uuid to a new value', error);
        return crypto.randomUUID();
    }
}

// Retained for backward compatibility with tests that called the former
// cache-reset helper. The cache no longer exists, so this is a no-op.
getOrGenerateSiteUuid._reset = () => {};

module.exports = {
    obfuscatedSetting,
    isSecretSetting,
    hideValueIfSecret,
    getOrGenerateSiteUuid
};
