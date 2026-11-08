/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest';
import { ChangeDetectionManager } from '../core/change-detection-manager';
import { DirectoryWatcher } from '../core/directory-watcher';
import type { JjService } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import type { LoggerChannel } from '../utils/output-channel';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMock, createMockLogOutputChannel, setPrivate } from './test-utils';

/**
 * Polling logic with fake timers: no jj process and no real watcher runs here, so this tier
 * owns it. The native-watcher integration stays in the repo tier.
 */
describe('ChangeDetectionManager polling', () => {
    let repoPath: string;
    let jj: JjService;
    let host: FakeHostEnvironment;
    let changeManager: ChangeDetectionManager | undefined;
    let outputChannel: LoggerChannel;
    let triggerRefreshSpy: Mock<
        (event: { forceSnapshot: boolean; reason: string; checkVersion?: boolean }) => Promise<void>
    >;

    beforeEach(async () => {
        repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-change-detection-'));
        await fs.mkdir(path.join(repoPath, '.jj', 'repo', 'op_heads', 'heads'), { recursive: true });

        jj = createMock<JjService>();
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
            // Dispose without awaiting: the manager stops on its own timer, which the fake
            // clock no longer advances, so awaiting it would hang the hook.
            void changeManager.dispose();
            changeManager = undefined;
        }
        await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});

        vi.clearAllMocks();
    });

    describe('Polling Logic (Fake Timers)', () => {
        let watcherStartSpy: MockInstance;

        beforeEach(() => {
            vi.useFakeTimers();
            // Suppress native watcher start for polling tests
            // We want to test logic, not integration here
            watcherStartSpy = vi.spyOn(DirectoryWatcher.prototype, 'start').mockResolvedValue();
        });

        afterEach(() => {
            watcherStartSpy.mockRestore();
            vi.clearAllTimers();
            vi.useRealTimers();
        });

        it('starts in polling mode by default and respects 5s gap after resolution', async () => {
            let resolveRefresh!: (value: void | PromiseLike<void>) => void;
            const refreshPromise = new Promise<void>((resolve) => {
                resolveRefresh = resolve;
            });

            triggerRefreshSpy.mockReturnValue(refreshPromise);

            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Initial 5s wait
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Wait another 5s while refresh is still pending
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1); // Should NOT have called again

            // 3. Resolve the refresh
            resolveRefresh();
            await vi.runAllTicks(); // Process promise resolution

            // Should NOT call immediately upon resolution
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 4. Wait 5s AFTER resolution
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2); // Now it should have called again
        });

        it('pauses polling when inactive and resumes when active', async () => {
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Initially active, wait for first poll (5s interval)
            await vi.advanceTimersByTimeAsync(5000);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 2. Set inactive
            host.ui.setActive(false);

            // Wait 5.1s, should NOT call refresh (paused)
            await vi.advanceTimersByTimeAsync(5100);

            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 3. Set active
            host.ui.setActive(true);

            // Wait for the immediate (10ms) poll to trigger
            await vi.advanceTimersByTimeAsync(100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2);

            // Wait another 5.1s to verify polling continues
            await vi.advanceTimersByTimeAsync(5100);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(3);
        });

        it('triggers active refresh with forceSnapshot: true and throttles within 10s', async () => {
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);
            triggerRefreshSpy.mockClear();

            // 1. Window becomes active -> triggers active refresh
            host.ui.setActive(true);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);
            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'active refresh',
            });

            // 2. Immediate active event again -> throttled
            host.ui.setActive(true);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // 3. Advance time by 5s (still within 10s throttle)
            await vi.advanceTimersByTimeAsync(5000);
            host.ui.setActive(true);
            // Poller may have fired once for the 5s interval, but active refresh shouldn't fire again
            const activeCalls = triggerRefreshSpy.mock.calls.filter((c) => c[0].reason === 'active refresh');
            expect(activeCalls).toHaveLength(1);

            // 4. Advance time by another 6s (total 11s > 10s) -> should trigger active refresh again
            await vi.advanceTimersByTimeAsync(6000);
            host.ui.setActive(true);
            const activeCallsAfter11s = triggerRefreshSpy.mock.calls.filter((c) => c[0].reason === 'active refresh');
            expect(activeCallsAfter11s).toHaveLength(2);
        });

        it('triggers throttled active refresh in watch mode', async () => {
            host.config.set('fileWatcherMode', 'watch');
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);
            triggerRefreshSpy.mockClear();

            // Window becoming active should trigger active refresh even in watch mode
            host.ui.setActive(true);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);
            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'active refresh',
            });

            // Window becoming active again immediately should be throttled
            host.ui.setActive(true);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(1);

            // Advance by 11s -> bypass throttle
            await vi.advanceTimersByTimeAsync(11000);
            host.ui.setActive(true);
            expect(triggerRefreshSpy).toHaveBeenCalledTimes(2);
        });

        it('defers active refresh when writes are active or recent', async () => {
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);
            triggerRefreshSpy.mockClear();

            // Simulate recent write operation
            setPrivate(changeManager, 'lastExternalOpTime', Date.now());

            // Window becoming active should defer refresh rather than dropping or running immediately
            host.ui.setActive(true);
            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            // Fast forward past the 500ms deferral timeout
            await vi.advanceTimersByTimeAsync(600);
            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'deferred watcher event',
                checkVersion: false,
            });
        });

        it('triggers refresh on file save (Host document save event)', async () => {
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);

            // Simulate host save event
            host.documents.fireDidSaveDocument(Uri.file(path.join(repoPath, 'test.txt')));

            expect(triggerRefreshSpy).toHaveBeenCalledWith({
                forceSnapshot: true,
                reason: 'file saved',
            });
        });

        it('ignores file save events for non-file schemes, .jj internal files, and files outside workspace', async () => {
            changeManager = new ChangeDetectionManager(repoPath, jj, outputChannel, triggerRefreshSpy, host);

            // 1. Non-file scheme
            host.documents.fireDidSaveDocument(Uri.parse('untitled:Untitled-1'));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            // 2. Internal .jj file
            host.documents.fireDidSaveDocument(Uri.file(path.join(repoPath, '.jj', 'repo', 'op_heads', 'head1')));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();

            // 3. File outside workspace
            host.documents.fireDidSaveDocument(Uri.file(path.join(repoPath, '..', 'outside.txt')));
            expect(triggerRefreshSpy).not.toHaveBeenCalled();
        });
    });
});
