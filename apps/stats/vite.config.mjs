import tailwindcss from '@tailwindcss/vite';
import adminXViteConfig from '@tryghost/admin-x-framework/vite';
import pkg from './package.json';
import svgr from 'vite-plugin-svgr';
import {resolve} from 'path';

export default (function viteConfig() {
    return adminXViteConfig({
        packageName: pkg.name,
        plugins: [
            svgr()
        ],
        entry: resolve(__dirname, 'src/index.tsx'),
        overrides: {
            // TownBrief: Tailwind v4's Vite plugin must be added via
            // `overrides.plugins` because adminXViteConfig's signature only
            // accepts {packageName, entry, overrides} — a top-level `plugins`
            // is silently dropped. mergeConfig() concatenates plugin arrays,
            // so tailwindcss() ends up alongside the framework's defaults
            // (svgr, react, externalPlugin, cssInjectedByJsPlugin). Without
            // this, the stats app builds successfully but renders unstyled.
            plugins: [tailwindcss()],
            test: {
                include: [
                    './test/unit/**/*',
                    './src/**/*.test.ts'
                ]
            },
            resolve: {
                alias: {
                    '@src': resolve(__dirname, './src'),
                    '@assets': resolve(__dirname, './src/assets'),
                    '@components': resolve(__dirname, './src/components'),
                    '@hooks': resolve(__dirname, './src/hooks'),
                    '@utils': resolve(__dirname, './src/utils'),
                    '@views': resolve(__dirname, './src/views')
                }
            }
        }
    });
});
