/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ChangeDetectionManager } from '../core/change-detection-manager';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { LoggerChannel } from '../utils/output-channel';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('ChangeDetectionManager gitignore filtering', () => {
    let repo: TestRepo;
    let jj: JjService;
    let host: FakeHostEnvironment;
    let changeManager: ChangeDetectionManager | undefined;
    let outputChannel: LoggerChannel;
    let triggerRefreshSpy: Mock<
        (event: { forceSnapshot: boolean; reason: string; checkVersion?: boolean }) => Promise<void>
    >;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();
        repo.ensureStore();

        jj = new JjService(repo.path, NO_OP_LOGGER);
        host = new FakeHostEnvironment();

        outputChannel = createMockLogOutputChannel({
            appendLine: vi.fn(),
        });

        triggerRefreshSpy = vi.fn().mockImplementation(() => Promise.resolve());

        // Default config: polling
        host.config.set('fileWatcherMode', 'polling');
    });

    afterEach(async () => {
        if (changeManager) {
            await changeManager.dispose();
            changeManager = undefined;
        }

        vi.clearAllMocks();
    });

    const waitForLog = async (pattern: string) => {
        await vi.waitFor(
            () => {
                const infoCalls = (outputChannel.info as Mock).mock.calls;
                const debugCalls = (outputChannel.debug as Mock).mock.calls;
                const errorCalls = (outputChannel.error as Mock).mock.calls;
                const calls = [...infoCalls, ...debugCalls, ...errorCalls];
                const found = calls.some((call) => call[0].includes(pattern));
                if (!found) {
                    throw new Error(`Log pattern "${pattern}" not found`);
                }
            },
            { timeout: 10000, interval: 50 },
        );
    };

    describe('gitignore rules (Real Timers)', () => {
        beforeEach(() => {
            vi.useRealTimers();
        });

        it('filters out negated patterns from .gitignore', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            // Create .gitignore with negated pattern and a directory to ignore
            await fs.writeFile(path.join(repo.path, '.gitignore'), 'ignore_me\n!keep_me\n#comment');
            await fs.mkdir(path.join(repo.path, 'ignore_me'), { recursive: true });

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for watcher to start, then settle to flush any
            // FSEvents catch-up events from the mkdir before the watcher started.
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 500));
            triggerRefreshSpy.mockClear();

            // Write to the ignored directory — should NOT trigger
            await fs.writeFile(path.join(repo.path, 'ignore_me', 'secret.txt'), 'hidden');

            // Wait to confirm no event fires for ignored file
            await new Promise((resolve) => setTimeout(resolve, 500));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'Ignored file should not have triggered a refresh').toHaveLength(0);

            // Write to a non-ignored path — SHOULD trigger
            await fs.writeFile(path.join(repo.path, 'visible.txt'), 'visible');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for visible.txt').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('honors nested .gitignore files', async () => {
            host.config.set('fileWatcherMode', 'watch');

            await fs.mkdir(path.join(repo.path, 'sub'), { recursive: true });
            await fs.writeFile(path.join(repo.path, 'sub', '.gitignore'), 'hidden.txt\n');
            await fs.writeFile(path.join(repo.path, 'sub', 'hidden.txt'), 'initial');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 500));
            triggerRefreshSpy.mockClear();

            await fs.writeFile(path.join(repo.path, 'sub', 'hidden.txt'), 'changed');
            await new Promise((resolve) => setTimeout(resolve, 500));

            const calls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(calls, 'Nested .gitignore should suppress the event').toHaveLength(0);
        });

        it('honors .git/info/exclude', async () => {
            host.config.set('fileWatcherMode', 'watch');

            await fs.mkdir(path.join(repo.path, '.git', 'info'), { recursive: true });
            await fs.writeFile(path.join(repo.path, '.git', 'info', 'exclude'), 'secret.txt\n');
            await fs.writeFile(path.join(repo.path, 'secret.txt'), 'initial');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 500));
            triggerRefreshSpy.mockClear();

            await fs.writeFile(path.join(repo.path, 'secret.txt'), 'changed');
            await new Promise((resolve) => setTimeout(resolve, 500));

            const calls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(calls, '.git/info/exclude should suppress the event').toHaveLength(0);
        });

        it('collects nested .gitignore files from directories that are not ignored', async () => {
            host.config.set('fileWatcherMode', 'watch');

            // `dist` used to be skipped by a hardcoded directory list; it must be walked now.
            await fs.mkdir(path.join(repo.path, 'dist'), { recursive: true });
            await fs.writeFile(path.join(repo.path, 'dist', '.gitignore'), 'x.log\n');
            await fs.writeFile(path.join(repo.path, 'dist', 'x.log'), 'initial');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 500));
            triggerRefreshSpy.mockClear();

            await fs.writeFile(path.join(repo.path, 'dist', 'x.log'), 'changed');
            await new Promise((resolve) => setTimeout(resolve, 500));

            const calls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(calls, 'dist/.gitignore must be honored').toHaveLength(0);
        });

        it('ignores directories matching literal patterns like /out/', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            repo.writeFile('.gitignore', '/out*/');

            const ignoredDir = path.join(repo.path, 'out');
            await fs.mkdir(ignoredDir, { recursive: true });

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for both watchers to start and settle. We wait for the op_heads watcher too
            // because it sets lastExternalOpTime, which makes hasActiveOrRecentWrites true for 500ms.
            await waitForLog('Working Copy Watcher] Started');
            await waitForLog('OpHeads Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));
            triggerRefreshSpy.mockClear();

            // 1. Write to the ignored directory — should NOT trigger
            await fs.writeFile(path.join(ignoredDir, 'build.log'), 'building...');

            // Wait to confirm no event fires for ignored file
            await new Promise((resolve) => setTimeout(resolve, 800));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'File in /out/ directory should not have triggered a refresh').toHaveLength(0);

            // 2. Write to a non-ignored path — SHOULD trigger.
            // IMPORTANT: Use fs.writeFile directly (not repo.writeFile) to avoid triggering
            // `jj status` (snapshot), which writes to op_heads and sets lastExternalOpTime,
            // causing hasActiveOrRecentWrites to suppress the working copy watcher callback.
            await fs.writeFile(path.join(repo.path, 'readme.md'), 'hello');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for readme.md').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('ignores secondary workspace directories', async () => {
            // Setup config to return 'watch'
            host.config.set('fileWatcherMode', 'watch');

            // Create a secondary workspace directory inside the main repo
            const secondRepo = repo.workspaceAdd('second_workspace');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            // Wait for watchers to start and settle
            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));
            triggerRefreshSpy.mockClear();

            // Write to the secondary workspace directory - should NOT trigger
            const secondWorkspaceFile = path.join(secondRepo.path, 'somefile.txt');
            await fs.writeFile(secondWorkspaceFile, 'change');

            // Wait to confirm no event fires for secondary workspace file
            await new Promise((resolve) => setTimeout(resolve, 800));
            const ignoredCalls = triggerRefreshSpy.mock.calls.filter((call) => call[0].reason === 'file watcher event');
            expect(ignoredCalls, 'File in secondary workspace should not have triggered a refresh').toHaveLength(0);

            // Write to a main workspace path - SHOULD trigger
            await fs.writeFile(path.join(repo.path, 'visible.txt'), 'visible');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Expected file watcher event for visible.txt').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });
    });
});
