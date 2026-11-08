/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { VitestPerfReporter } from './tooling/vitest-perf-reporter';

const isWindows = process.platform === 'win32';
const traceFile = path.join(os.tmpdir(), `jj-view-perf-trace-${process.pid}.jsonl`);

export default defineConfig({
    plugins: [svelte()],
    test: {
        include: ['src/test/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
        // Integration tests need a real VS Code host; repo tests need a real jj/git working copy.
        exclude: ['src/test/**/*.integration.test.ts', 'src/test/**/*.repo.test.ts'],
        // Temporary global setup to provide vscode mock during host abstraction retrofit
        setupFiles: ['./src/test/vitest-setup.ts'],
        globals: true,
        env: {
            JJ_VIEW_PERF_TRACE_FILE: traceFile,
        },
        // dot: one character per test (fast to scan); the perf reporter adds the CLI
        // subprocess ranking at the end. A CLI `--reporter=...` would replace this list.
        reporters: ['dot', new VitestPerfReporter(traceFile)],
        // Threads start far faster than forked processes, which matters on Windows.
        pool: 'threads',
        // Unit tests are pure logic; anything slower than this belongs in the repo tier.
        testTimeout: 5000,
        hookTimeout: 5000,
        retry: isWindows && process.env.CI ? 1 : 0,
        maxWorkers: isWindows && process.env.CI ? 2 : undefined,
        // `execArgv` is rejected by worker threads (ERR_WORKER_INVALID_EXEC_ARGV); set the heap
        // limit through NODE_OPTIONS instead when a larger heap is needed.
    },
});
