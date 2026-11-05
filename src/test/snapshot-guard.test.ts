/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusedSnapshotGuard, type SnapshotState } from '../core/repos/snapshot-guard';

describe('FocusedSnapshotGuard', () => {
    const root = 'C:\\repo';

    const create = (state: () => SnapshotState, refresh: () => Promise<void>, onReady = vi.fn(), onError = vi.fn()) =>
        new FocusedSnapshotGuard({
            focusedRoot: () => root,
            probe: () => state(),
            refresh,
            onReady,
            onError,
            delayMs: 400,
            maxRetries: 3,
        });

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refreshes when no snapshot exists and reports readiness', async () => {
        let snapshot: SnapshotState = { hasSnapshot: false, builtFocused: false };
        const refresh = vi.fn(async () => {
            snapshot = { hasSnapshot: true, builtFocused: true };
        });
        const onReady = vi.fn();

        create(() => snapshot, refresh, onReady).run();
        await vi.runAllTimersAsync();

        expect(refresh).toHaveBeenCalledTimes(1);
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('refreshes a snapshot that was built while the repository was unfocused', async () => {
        let snapshot: SnapshotState = { hasSnapshot: true, builtFocused: false };
        const refresh = vi.fn(async () => {
            snapshot = { hasSnapshot: true, builtFocused: true };
        });

        create(() => snapshot, refresh).run();
        await vi.runAllTimersAsync();

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the snapshot is already usable', async () => {
        const refresh = vi.fn(async () => {});
        const onReady = vi.fn();

        create(() => ({ hasSnapshot: true, builtFocused: true }), refresh, onReady).run();
        await vi.runAllTimersAsync();

        expect(refresh).not.toHaveBeenCalled();
        expect(onReady).not.toHaveBeenCalled();
    });

    it('retries a bounded number of times when the refresh does not help', async () => {
        const refresh = vi.fn(async () => {});
        const onError = vi.fn();

        create(() => ({ hasSnapshot: false, builtFocused: false }), refresh, vi.fn(), onError).run();
        await vi.runAllTimersAsync();

        // Initial attempt plus three retries.
        expect(refresh).toHaveBeenCalledTimes(4);
    });

    it('keeps retrying after a rejected refresh and reports the error', async () => {
        let calls = 0;
        const refresh = vi.fn(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error('jj is busy');
            }
        });
        const onError = vi.fn();
        let snapshot: SnapshotState = { hasSnapshot: false, builtFocused: false };

        create(
            () => snapshot,
            async () => {
                await refresh();
                snapshot = { hasSnapshot: true, builtFocused: true };
            },
            vi.fn(),
            onError,
        ).run();
        await vi.runAllTimersAsync();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(snapshot.builtFocused).toBe(true);
    });

    it('stops scheduled work after dispose', async () => {
        const refresh = vi.fn(async () => {});
        const guard = create(() => ({ hasSnapshot: false, builtFocused: false }), refresh);

        guard.run();
        guard.dispose();
        await vi.runAllTimersAsync();

        expect(refresh).toHaveBeenCalledTimes(1);
    });
});
