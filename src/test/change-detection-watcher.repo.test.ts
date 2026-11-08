/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ChangeDetectionManager } from '../core/change-detection-manager';
import { DirectoryWatcher } from '../core/directory-watcher';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { Poller } from '../core/poller';
import type { LoggerChannel } from '../utils/output-channel';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { accessPrivate, createMockLogOutputChannel, setPrivate } from './test-utils';

describe('ChangeDetectionManager native watcher integration', () => {
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

    describe('Native Watcher Integration (Real Timers)', () => {
        beforeEach(() => {
            vi.useRealTimers();
        });

        // === Reconnect and deferred refresh ===

        it('triggers refresh with forceSnapshot: true when working copy watcher reconnects without active writes', async () => {
            host.config.set('fileWatcherMode', 'watch');
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');
            triggerRefreshSpy.mockClear();

            const wcWatcher = accessPrivate<DirectoryWatcher | undefined>(changeManager, '_workingCopyWatcher');
            expect(wcWatcher).toBeDefined();
            if (!wcWatcher) {
                throw new Error('Working copy watcher undefined');
            }
            const onReconnect = accessPrivate<(() => void) | undefined>(wcWatcher, 'onReconnect');
            expect(onReconnect).toBeDefined();

            onReconnect?.();

            await vi.waitFor(() => {
                expect(triggerRefreshSpy).toHaveBeenCalledWith({
                    forceSnapshot: true,
                    reason: 'file watcher reconnected',
                });
            });
        });

        it('triggers refresh with forceSnapshot: false when op_heads watcher reconnects without active writes', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('OpHeads Watcher] Started');
            triggerRefreshSpy.mockClear();

            const opHeadsWatcher = accessPrivate<DirectoryWatcher | undefined>(changeManager, '_opHeadsWatcher');
            expect(opHeadsWatcher).toBeDefined();
            if (!opHeadsWatcher) {
                throw new Error('OpHeads watcher undefined');
            }
            const onReconnect = accessPrivate<(() => void) | undefined>(opHeadsWatcher, 'onReconnect');
            expect(onReconnect).toBeDefined();

            onReconnect?.();

            await vi.waitFor(() => {
                expect(triggerRefreshSpy).toHaveBeenCalledWith({
                    forceSnapshot: false,
                    reason: 'op_heads watcher reconnected',
                    checkVersion: true,
                });
            });
        });

        it('defers refresh when working copy watcher reconnects during active writes', async () => {
            host.config.set('fileWatcherMode', 'watch');
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');
            triggerRefreshSpy.mockClear();

            setPrivate(changeManager, 'lastExternalOpTime', Date.now());

            const wcWatcher = accessPrivate<DirectoryWatcher | undefined>(changeManager, '_workingCopyWatcher');
            if (!wcWatcher) {
                throw new Error('Working copy watcher undefined');
            }
            const onReconnect = accessPrivate<(() => void) | undefined>(wcWatcher, 'onReconnect');

            onReconnect?.();

            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            await vi.waitFor(
                () => {
                    expect(triggerRefreshSpy).toHaveBeenCalledWith({
                        forceSnapshot: true,
                        reason: 'deferred watcher event',
                        checkVersion: false,
                    });
                },
                { timeout: 2000, interval: 50 },
            );
        });

        it('latches forceSnapshot across multiple deferred refresh schedules', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await changeManager.awaitWatchersReady();
            triggerRefreshSpy.mockClear();

            setPrivate(changeManager, 'lastExternalOpTime', Date.now());

            const scheduleDeferred = accessPrivate<(force?: boolean) => void>(
                changeManager,
                '_scheduleDeferredRefresh',
            );
            scheduleDeferred.call(changeManager, true);
            scheduleDeferred.call(changeManager, false);

            await vi.waitFor(
                () => {
                    expect(triggerRefreshSpy).toHaveBeenCalledWith({
                        forceSnapshot: true,
                        reason: 'deferred watcher event',
                        checkVersion: false,
                    });
                },
                { timeout: 2000, interval: 50 },
            );
        });

        // === op_heads events ===

        it('forwards self-produced op_heads changes with a version check', async () => {
            host.config.set('fileWatcherMode', 'watch');
            setPrivate(jj, '_lastWriteTime', Date.now());
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('OpHeads Watcher] Started');
            triggerRefreshSpy.mockClear();

            const headsDir = path.join(repo.path, '.jj', 'repo', 'op_heads', 'heads');
            await fs.writeFile(path.join(headsDir, 'self-produced-op'), 'op');

            await vi.waitFor(
                () => {
                    const forwarded = triggerRefreshSpy.mock.calls.some((call) => call[0]?.checkVersion === true);
                    expect(forwarded, 'self-produced op_heads event must reach the repository').toBe(true);
                },
                { timeout: 2000, interval: 50 },
            );
        });

        it('refreshes on op_heads changes that are not self-produced', async () => {
            host.config.set('fileWatcherMode', 'watch');
            setPrivate(jj, '_lastWriteTime', Date.now() - 5000);
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('OpHeads Watcher] Started');
            triggerRefreshSpy.mockClear();

            const headsDir = path.join(repo.path, '.jj', 'repo', 'op_heads', 'heads');
            await fs.writeFile(path.join(headsDir, 'external-op'), 'op');

            await vi.waitFor(
                () => {
                    expect(triggerRefreshSpy).toHaveBeenCalledWith({
                        forceSnapshot: false,
                        reason: 'jj operation',
                        checkVersion: true,
                    });
                },
                { timeout: 5000, interval: 100 },
            );
        });

        it('handles op_heads changes with real watcher', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            await waitForLog('OpHeads Watcher] Started');

            const triggeringRepo = new TestRepo(repo.path);
            triggeringRepo.new([], 'trigger refresh');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'jj operation');
                    expect(found, 'Trigger refresh for jj operation was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('handles op_heads changes in non-default workspace', async () => {
            const secondRepo = repo.workspaceAdd('second_workspace');
            const secondJj = new JjService(secondRepo.path, {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {},
            });

            changeManager = new ChangeDetectionManager(
                secondRepo.path,
                secondJj,
                outputChannel,
                triggerRefreshSpy,
                host,
            );

            await waitForLog('OpHeads Watcher] Started');

            secondRepo.new([], 'trigger refresh');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'jj operation');
                    expect(found, 'Trigger refresh for jj operation was not called in second workspace').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        // === Lifecycle and mode switching ===

        it('falls back to polling mode when working copy watcher reports permanent failure', async () => {
            host.config.set('fileWatcherMode', 'watch');
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('Working Copy Watcher] Started');

            const wcWatcher = accessPrivate<DirectoryWatcher | undefined>(changeManager, '_workingCopyWatcher');
            if (!wcWatcher) {
                throw new Error('Working copy watcher undefined');
            }
            const onPermanentFailure = accessPrivate<((err: unknown) => void) | undefined>(
                wcWatcher,
                'onPermanentFailure',
            );
            expect(onPermanentFailure).toBeDefined();

            onPermanentFailure?.(new Error('inotify watch limit reached'));

            await waitForLog('Falling back to polling mode');
            expect(accessPrivate<string>(changeManager, '_fileWatcherMode')).toBe('polling');
            expect(accessPrivate<DirectoryWatcher | undefined>(changeManager, '_workingCopyWatcher')).toBeUndefined();
            const poller = accessPrivate<Poller>(changeManager, '_poller');
            expect(accessPrivate<boolean>(poller, '_isPolling')).toBe(true);
        });

        it('cleans up op_heads watcher when reporting permanent failure', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);
            await waitForLog('OpHeads Watcher] Started');

            const opHeadsWatcher = accessPrivate<DirectoryWatcher | undefined>(changeManager, '_opHeadsWatcher');
            if (!opHeadsWatcher) {
                throw new Error('OpHeads watcher undefined');
            }
            const onPermanentFailure = accessPrivate<((err: unknown) => void) | undefined>(
                opHeadsWatcher,
                'onPermanentFailure',
            );
            expect(onPermanentFailure).toBeDefined();

            onPermanentFailure?.(new Error('inotify watch limit reached'));

            await waitForLog('OpHeads watcher permanently failed');
            expect(accessPrivate<DirectoryWatcher | undefined>(changeManager, '_opHeadsWatcher')).toBeUndefined();
        });

        it('falls back to polling mode if working copy watcher fails to start', async () => {
            const watcherStartSpy = vi.spyOn(DirectoryWatcher.prototype, 'start').mockImplementation(async function (
                this: DirectoryWatcher,
            ) {
                const name = accessPrivate<string>(this, 'name');
                if (name === 'Working Copy Watcher') {
                    throw new Error('Watch backend startup failure simulation');
                }
            });

            try {
                host.config.set('fileWatcherMode', 'watch');
                changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

                await waitForLog('Falling back to polling mode');
                expect(outputChannel.info).toHaveBeenCalledWith(
                    expect.stringContaining('Falling back to polling mode'),
                );
            } finally {
                watcherStartSpy.mockRestore();
            }
        });

        it('switches to watch mode when configured and detects changes', async () => {
            host.config.set('fileWatcherMode', 'watch');

            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));

            const testFile = path.join(repo.path, 'test_watch.txt');
            await fs.writeFile(testFile, 'hello');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Trigger refresh for file watcher event was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });

        it('switches mode dynamically when onDidChangeConfiguration fires at runtime', async () => {
            changeManager = new ChangeDetectionManager(repo.path, jj, outputChannel, triggerRefreshSpy, host);

            await changeManager.awaitWatchersReady();

            host.config.set('fileWatcherMode', 'watch');

            await waitForLog('Working Copy Watcher] Started');
            await new Promise((resolve) => setTimeout(resolve, 800));

            const testFile = path.join(repo.path, 'dynamic_watch.txt');
            await fs.writeFile(testFile, 'dynamic');

            await vi.waitFor(
                () => {
                    const found = triggerRefreshSpy.mock.calls.some((call) => call[0].reason === 'file watcher event');
                    expect(found, 'Trigger refresh for dynamic file watcher event was not called').toBe(true);
                },
                { timeout: 10000, interval: 100 },
            );
        });
    });
});
