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
const isWindows = process.platform === 'win32';

export default defineConfig({
    // Required: `vscode-commit-details-editor-provider.repo.test.ts` transitively imports
    // `CommitDetailsApp.svelte` for SSR. Removing the plugin breaks that suite at import time.
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
        // Repo tests mostly wait on jj subprocesses, so more workers than cores still helps.
        // 10 workers made the fast tier slower (process/disk thrash); 6 is the measured sweet
        // spot until P1-2 removes most jj invocations.
        maxWorkers: isWindows ? 6 : 4,
        fileParallelism: true,
        // Files are independent working copies; skipping isolation removes module reload cost.
        isolate: false,
        // Hard budget from 测试提速计划.md: a single repo test must fit the 60s fast tier,
        // so 45s leaves room for the rest of the file. Tests that hit this are slow and must
        // be optimized instead of silently waiting; the full tier target is 3 minutes.
        testTimeout: 45000,
        hookTimeout: 45000,
        teardownTimeout: 10000,
    },
});
