import path from 'path';
import react from '@vitejs/plugin-react';
import {globSync} from 'glob';
import {resolve} from 'path';
import {defineConfig} from 'vitest/config';

// https://vitejs.dev/config/
export default (function viteConfig() {
    return defineConfig({
        logLevel: process.env.CI ? 'info' : 'warn',
        plugins: [
            react()
        ],
        resolve: {
            alias: {
                '@': path.resolve(__dirname, './src')
            }
        },
        preview: {
            port: 4174
        },
        build: {
            reportCompressedSize: false,
            minify: false,
            sourcemap: true,
            outDir: 'dist',
            lib: {
                formats: ['es', 'cjs'],
                entry: globSync('src/**/*.{ts,tsx}', {cwd: __dirname, posix: true}).reduce((entries, libpath) => {
                    if (libpath.endsWith('.d.ts')) {
                        return entries;
                    }

                    // libpath is a posix-style relative path like 'src/api/sites.ts'.
                    // outPath is 'api/sites' (no extension, no leading src/).
                    const outPath = libpath.replace(/^src\//, '').replace(/\.(ts|tsx)$/, '');
                    entries[outPath] = resolve(__dirname, libpath);
                    return entries;
                }, {} as Record<string, string>)
            },
            commonjsOptions: {
                include: [/packages/, /node_modules/]
            },
            rollupOptions: {
                external: (source) => {
                    if (source.startsWith('.')) {
                        return false;
                    }

                    if (source.includes('node_modules')) {
                        return true;
                    }

                    // Normalize both sides to forward-slash for Windows
                    // comparison — `source` rollup passes in is sometimes
                    // a relative posix path like `src/foo.ts` and other
                    // times an absolute Windows path. `__dirname` here
                    // is always native (backslash) on Windows.
                    const srcAbs = source.replace(/\\/g, '/');
                    const dirAbs = __dirname.replace(/\\/g, '/');
                    if (srcAbs.includes(dirAbs)) return false;
                    if (srcAbs.startsWith('src/') || srcAbs.startsWith('/src/')) return false;
                    return true;
                }
            }
        },
        test: {
            globals: true, // required for @testing-library/jest-dom extensions
            environment: 'jsdom',
            include: ['./test/unit/**/*'],
            setupFiles: ['./test/setup.ts'],
            testTimeout: process.env.TIMEOUT ? parseInt(process.env.TIMEOUT) : 10000,
            ...(process.env.CI && { // https://github.com/vitest-dev/vitest/issues/1674
                minThreads: 1,
                maxThreads: 2
            })
        }
    });
});
