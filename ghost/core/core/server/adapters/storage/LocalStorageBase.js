// # Local File Base Storage module
// The (default) module for storing files using the local file system
const serveStatic = require('../../../shared/express').static;

const fs = require('fs-extra');
const path = require('path');
const tpl = require('@tryghost/tpl');
const errors = require('@tryghost/errors');
const urlUtils = require('../../../shared/url-utils');
const StorageBase = require('ghost-storage-base');

function getCurrentSiteSlug() {
    try {
        const {getCurrentSite} = require('../../services/multitenancy/current-site');
        const site = getCurrentSite();
        return (site && site.slug) ? site.slug : null;
    } catch {
        return null;
    }
}

const messages = {
    notFound: 'File not found',
    notFoundWithRef: 'File not found: {file}',
    cannotRead: 'Could not read file: {file}',
    invalidUrlParameter: `The URL "{url}" is not a valid URL for this site.`,
    invalidPathParameter: 'The path "{path}" is not valid for this storage.'
};

class LocalStorageBase extends StorageBase {
    /**
     *
     * @param {Object} options
     * @param {string} options.storagePath
     * @param {string} options.siteUrl
     * @param {string} [options.staticFileURLPrefix]
     * @param {Object} [options.errorMessages]
     * @param {string} [options.errorMessages.notFound]
     * @param {string} [options.errorMessages.notFoundWithRef]
     * @param {string} [options.errorMessages.cannotRead]
     */
    constructor({storagePath, staticFileURLPrefix, siteUrl, errorMessages}) {
        super();

        this.storagePath = storagePath;
        this.staticFileURLPrefix = staticFileURLPrefix;
        this.siteUrl = siteUrl;
        this.staticFileUrl = `${siteUrl}${staticFileURLPrefix}`;
        this.errorMessages = errorMessages || messages;
    }

    /**
     * Normalizes a relative storage path and rejects traversal outside the storage root.
     *
     * @param {string} filePath
     * @returns {string}
     */
    _normalizeStorageRelativePath(filePath) {
        const normalized = path.posix.normalize(String(filePath || '')
            .replaceAll('\\', '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, ''));

        if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
            throw new errors.IncorrectUsageError({
                message: tpl(messages.invalidPathParameter, {path: filePath})
            });
        }

        return normalized;
    }

    /**
     * Resolves a target directory and optional file name into a full path,
     * validating the result is inside the storage root.
     *
     * Supports relative paths (preferred) and absolute paths (legacy).
     * TODO: remove absolute path support once all callers pass relative paths
     *
     * @param {string} [targetDir] absolute or relative directory
     * @param {string} [fileName] file name to normalize and append
     * @returns {string} resolved absolute path inside storagePath
     */
    _resolveAndValidateStoragePath(targetDir, fileName) {
        const resolvedRoot = path.resolve(this.storagePath);

        // Resolve targetDir: if already inside storage root use as-is, otherwise treat as relative
        let resolvedBase;
        if (targetDir) {
            const resolvedTargetDir = path.resolve(targetDir);
            const relToRoot = path.relative(resolvedRoot, resolvedTargetDir);
            if (relToRoot === '' || (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot))) {
                resolvedBase = resolvedTargetDir;
            } else {
                resolvedBase = path.resolve(this.storagePath, targetDir);
            }
        } else {
            resolvedBase = resolvedRoot;
        }

        // If fileName provided, normalize and resolve
        let resolvedPath;
        if (fileName) {
            const normalizedFileName = this._normalizeStorageRelativePath(fileName);
            resolvedPath = path.resolve(resolvedBase, normalizedFileName);
        } else {
            resolvedPath = resolvedBase;
        }

        // Validate the resolved path is strictly inside the storage root (not equal to it)
        const relative = path.relative(resolvedRoot, resolvedPath);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new errors.IncorrectUsageError({
                message: tpl(messages.invalidPathParameter, {path: fileName || targetDir || ''})
            });
        }

        return resolvedPath;
    }

    /**
     * Saves the file to storage (the file system)
     * - returns a promise which ultimately returns the full url to the uploaded file
     *
     * @param {StorageBase.Image} file
     * @param {string} targetDir
     * @returns {Promise<String>}
     */
    async save(file, targetDir) {
        let targetFilename;

        // Per-site image isolation: store under <storagePath>/<slug>/...
        // so each site's uploads are namespaced. The URL returned uses the
        // path WITHOUT the slug prefix; serve() re-injects it at request time.
        const slug = getCurrentSiteSlug();
        const siteStoragePath = slug ? path.join(this.storagePath, slug) : this.storagePath;

        targetDir = targetDir
            ? path.join(siteStoragePath, path.relative(this.storagePath,
                this._resolveAndValidateStoragePath(targetDir)))
            : this.getTargetDir(siteStoragePath);

        const filename = await this.getUniqueFileName(file, targetDir);

        targetFilename = filename;
        await fs.mkdirs(targetDir);

        try {
            await fs.copy(file.path, targetFilename);
        } catch (err) {
            if (err.code === 'ENAMETOOLONG') {
                throw new errors.BadRequestError({err});
            }

            throw err;
        }

        // Return URL relative to the SHARED storagePath (no slug prefix) so
        // __GHOST_URL__ links stay portable across sites.
        const fullUrl = (
            urlUtils.urlJoin('/',
                urlUtils.getSubdir(),
                this.staticFileURLPrefix,
                path.relative(siteStoragePath, targetFilename))
        ).replace(new RegExp(`\\${path.sep}`, 'g'), '/');

        return fullUrl;
    }

    /**
     * Saves a buffer in the targetPath
     * @param {Buffer} buffer is an instance of Buffer
     * @param {string} targetPath relative path NOT including storage path to which the buffer should be written
     * @returns {Promise<String>} a URL to retrieve the data
     */
    async saveRaw(buffer, targetPath) {
        const slug = getCurrentSiteSlug();
        const siteStoragePath = slug ? path.join(this.storagePath, slug) : this.storagePath;
        const storagePath = path.join(siteStoragePath, this._normalizeStorageRelativePath(targetPath));
        const targetDir = path.dirname(storagePath);

        await fs.mkdirs(targetDir);
        await fs.writeFile(storagePath, buffer);

        const fullUrl = (
            urlUtils.urlJoin('/', urlUtils.getSubdir(),
                this.staticFileURLPrefix,
                targetPath)
        ).replace(new RegExp(`\\${path.sep}`, 'g'), '/');

        return fullUrl;
    }

    /**
     * @param {string} url full url under which the stored content is served, result of save method
     * @returns {string} relative path under which the content is stored
     */
    urlToPath(url) {
        let relativePath;

        const prefix = urlUtils.urlJoin('/',
            urlUtils.getSubdir(),
            this.staticFileURLPrefix
        );

        if (url.startsWith(this.staticFileUrl)) {
            // CASE: full path that includes the site url
            relativePath = url.replace(this.staticFileUrl, '');
        } else if (url.startsWith(prefix)) {
            // CASE: The result of the save method doesn't include the site url. So we need to handle this case.
            relativePath = url.replace(prefix, '');
        } else {
            throw new errors.IncorrectUsageError({
                message: tpl(messages.invalidUrlParameter, {url})
            });
        }

        try {
            return this._normalizeStorageRelativePath(relativePath);
        } catch (err) {
            throw new errors.IncorrectUsageError({
                message: tpl(messages.invalidUrlParameter, {url})
            });
        }
    }

    async exists(fileName, targetDir) {
        let filePath;

        try {
            filePath = this._resolveAndValidateStoragePath(targetDir, fileName);
        } catch (err) {
            if (err instanceof errors.IncorrectUsageError) {
                return false;
            }
            throw err;
        }

        // Check per-site path first, then shared fallback
        const slug = getCurrentSiteSlug();
        if (slug) {
            const rel = path.relative(this.storagePath, filePath);
            const perSitePath = path.join(this.storagePath, slug, rel);
            try {
                await fs.stat(perSitePath);
                return true;
            } catch {
                // fall through to shared check
            }
        }

        try {
            await fs.stat(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * For some reason send divides the max age number by 1000
     * Fallthrough: false ensures that if an image isn't found, it automatically 404s
     * Wrap server static errors
     *
     * Per-site isolation: tries <storagePath>/<site-slug>/ first, then falls
     * back to <storagePath>/ for legacy/shared files.
     *
     * @returns {serveStaticContent}
     */
    serve() {
        const {storagePath, errorMessages} = this;
        const perSiteHandlers = new Map();

        const getPerSiteHandler = (slug) => {
            if (!perSiteHandlers.has(slug)) {
                perSiteHandlers.set(slug, serveStatic(
                    path.join(storagePath, slug),
                    {maxAge: 365 * 24 * 60 * 60 * 1000, fallthrough: false}
                ));
            }
            return perSiteHandlers.get(slug);
        };

        const sharedHandler = serveStatic(storagePath, {
            maxAge: 365 * 24 * 60 * 60 * 1000,
            fallthrough: false
        });

        function mapError(err, next) {
            if (!err) {
                return next();
            }
            if (err.statusCode === 404) {
                return next(new errors.NotFoundError({
                    message: tpl(errorMessages.notFound),
                    code: 'STATIC_FILE_NOT_FOUND',
                    property: err.path
                }));
            }
            if (err.statusCode === 400) {
                return next(new errors.BadRequestError({err}));
            }
            if (err.statusCode === 403) {
                return next(new errors.NoPermissionError({err}));
            }
            if (err.name === 'RangeNotSatisfiableError') {
                return next(new errors.RangeNotSatisfiableError({err}));
            }
            return next(new errors.InternalServerError({err}));
        }

        return function serveStaticContent(req, res, next) {
            const slug = getCurrentSiteSlug();

            if (slug) {
                getPerSiteHandler(slug)(req, res, (err) => {
                    if (err && err.statusCode === 404) {
                        // Not in per-site dir — fall back to shared (legacy/bootstrap files)
                        sharedHandler(req, res, err2 => mapError(err2, next));
                    } else {
                        mapError(err, next);
                    }
                });
            } else {
                sharedHandler(req, res, err => mapError(err, next));
            }
        };
    }

    /**
     * @param {string} filePath
     * @returns {Promise.<*>}
     */
    async delete(fileName, targetDir) {
        const filePath = this._resolveAndValidateStoragePath(targetDir, fileName);
        const slug = getCurrentSiteSlug();
        if (slug) {
            const rel = path.relative(this.storagePath, filePath);
            const perSitePath = path.join(this.storagePath, slug, rel);
            try {
                await fs.stat(perSitePath);
                return await fs.remove(perSitePath);
            } catch {
                // fall through to shared path
            }
        }
        return await fs.remove(filePath);
    }

    /**
     * Reads bytes from disk for a target file
     * - path of target file (without content path!)
     *
     * @param options
     */
    async read(options) {
        options = options || {};

        const normalizedPath = this._normalizeStorageRelativePath(options.path);
        const slug = getCurrentSiteSlug();

        const tryRead = async (targetPath) => {
            try {
                return await fs.readFile(targetPath);
            } catch (err) {
                if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
                    return null;
                }
                if (err.code === 'ENAMETOOLONG') {
                    throw new errors.BadRequestError({err});
                }
                if (err.code === 'EACCES') {
                    throw new errors.NoPermissionError({err});
                }
                throw new errors.InternalServerError({err, message: tpl(this.errorMessages.cannotRead, {file: options.path})});
            }
        };

        if (slug) {
            const perSitePath = path.join(this.storagePath, slug, normalizedPath);
            const data = await tryRead(perSitePath);
            if (data !== null) {
                return data;
            }
        }

        const sharedPath = path.join(this.storagePath, normalizedPath);
        const data = await tryRead(sharedPath);
        if (data !== null) {
            return data;
        }

        throw new errors.NotFoundError({
            message: tpl(this.errorMessages.notFoundWithRef, {file: options.path})
        });
    }
}

module.exports = LocalStorageBase;
