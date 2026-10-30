/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { VitestPerfReporter } from './tooling/vitest-perf-reporter';

/**
 * Repository-tier tests: every file creates a real jj/git working copy and shells out
 * to the jj binary, so they are kept out of the default unit run (`vitest.config.ts`)
 * and only executed explicitly (`pnpm test:repo`) or in CI before merging.
 */
const traceFile = path.join(os.tmpdir(), `jj-view-perf-trace-repo-${process.pid}.jsonl`);

export default defineConfig({
    plugins: [svelte()],
    test: {
        include: ['src/test/**/*.repo.test.ts'],
        setupFiles: ['./src/test/vitest-setup.ts'],
        globals: true,
        env: {
            JJ_VIEW_PERF_TRACE_FILE: traceFile,
        },
        reporters: ['default', new VitestPerfReporter(traceFile)],
        pool: 'threads',
        testTimeout: 120000,
        hookTimeout: 120000,
    },
});
