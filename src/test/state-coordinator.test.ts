/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StateCoordinator, type VerifiableState } from '../core/repos/state-coordinator';

describe('StateCoordinator', () => {
    let now = 0;

    beforeEach(() => {
        now = 0;
    });

    const repo = (overrides: Partial<VerifiableState> = {}): VerifiableState => ({
        root: 'C:\\repo',
        truth: async () => 'v1',
        snapshotVersion: () => 'v1',
        repairSnapshot: vi.fn(async () => {}),
        ...overrides,
    });

    const create = (onError = vi.fn()) => new StateCoordinator({ cooldownMs: 1000, now: () => now, onError });

    it('does nothing when every view matches the repository', async () => {
        const target = repo();
        const repaired = await create().verifyAndRepair([target], 'test');

        expect(repaired).toEqual([]);
        expect(target.repairSnapshot).not.toHaveBeenCalled();
    });

    it('repairs the repository whose snapshot lags behind', async () => {
        const target = repo({ snapshotVersion: () => 'v0' });
        const repaired = await create().verifyAndRepair([target], 'test');

        expect(repaired).toEqual(['C:\\repo']);
        expect(target.repairSnapshot).toHaveBeenCalledTimes(1);
    });

    it('repairs the log when only the log lags behind', async () => {
        const target = repo({ logVersion: () => 'v0', repairLog: vi.fn(async () => {}) });
        await create().verifyAndRepair([target], 'test');

        expect(target.repairSnapshot).toHaveBeenCalledTimes(1);
        expect(target.repairLog).toHaveBeenCalledTimes(1);
    });

    it('honours the cooldown between repairs', async () => {
        const target = repo({ snapshotVersion: () => 'v0' });
        const coordinator = create();

        await coordinator.verifyAndRepair([target], 'first');
        await coordinator.verifyAndRepair([target], 'second');
        expect(target.repairSnapshot).toHaveBeenCalledTimes(1);

        now += 1500;
        await coordinator.verifyAndRepair([target], 'third');
        expect(target.repairSnapshot).toHaveBeenCalledTimes(2);
    });

    it('reports verification and repair failures without throwing', async () => {
        const onError = vi.fn();
        const broken = repo({
            truth: async () => {
                throw new Error('op_heads unreadable');
            },
        });
        const failing = repo({
            snapshotVersion: () => 'v0',
            repairSnapshot: async () => {
                throw new Error('jj busy');
            },
        });

        await create(onError).verifyAndRepair([broken, failing], 'test');

        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to verify'), expect.any(Error));
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Repair failed'), expect.any(Error));
    });

    it('verifies repositories that no view is showing', async () => {
        const withLog = repo({ logVersion: () => 'v0', repairLog: vi.fn(async () => {}) });
        const repaired = await create().verifyAndRepair([withLog], 'repos view');

        expect(repaired).toEqual(['C:\\repo']);
    });
});
