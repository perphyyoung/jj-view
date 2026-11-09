/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compile-only check for the extension and webview bundles. Uses esbuild's
 * `write: false` so no dist/ output is produced: `tsc --noEmit` does not parse
 * .svelte files, so this is the only step that catches Svelte compile errors
 * and broken bundle imports.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const sveltePlugin = require('esbuild-svelte');

const common = {
    bundle: true,
    sourcesContent: false,
    write: false,
    logLevel: 'silent',
    plugins: [
        sveltePlugin({
            compilerOptions: { dev: false, generate: 'server' },
        }),
    ],
};

const webviewPlugins = [
    sveltePlugin({
        compilerOptions: { dev: true, css: 'external' },
    }),
];

const builds = [
    {
        name: 'extension',
        options: {
            ...common,
            entryPoints: ['src/vscode/extension.ts'],
            format: 'cjs',
            platform: 'node',
            outfile: 'dist/extension.js',
            external: ['vscode'],
        },
    },
    {
        name: 'webview',
        options: {
            ...common,
            plugins: webviewPlugins,
            entryPoints: {
                index: 'src/core/webview/log/index.ts',
                changes: 'src/core/webview/changes/index.ts',
                'commit-details': 'src/core/webview/commit-details/index.ts',
                'process-monitor': 'src/core/webview/process-monitor/index.ts',
                'line-history': 'src/core/webview/line-history/index.ts',
            },
            format: 'iife',
            platform: 'browser',
            outdir: 'dist/webview',
            define: { 'process.env.NODE_ENV': '"development"' },
            banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
        },
    },
];

try {
    await Promise.all(builds.map(({ options }) => esbuild.build(options)));
    console.log('[check:bundle] extension + webview compiled (no output written).');
} catch (error) {
    const errors = error?.errors ?? [];
    for (const { text, location } of errors) {
        const where = location ? `${location.file}:${location.line}:${location.column}` : '';
        console.error(`[check:bundle] ${text}${where ? ` at ${where}` : ''}`);
    }
    if (errors.length === 0) {
        console.error(`[check:bundle] ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
}
