/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { verifyVersions } from '../core/repos/state-invariants';

describe('verifyVersions', () => {
    it('accepts data computed from the current version', () => {
        expect(verifyVersions({ truth: 'v2', snapshotVersion: 'v2', logVersion: 'v2' })).toEqual({
            ok: true,
            staleSnapshot: false,
            staleLog: false,
        });
    });

    it('flags the snapshot when it lags behind', () => {
        expect(verifyVersions({ truth: 'v2', snapshotVersion: 'v1', logVersion: 'v2' })).toEqual({
            ok: false,
            staleSnapshot: true,
            staleLog: false,
        });
    });

    it('flags the log when it lags behind', () => {
        expect(verifyVersions({ truth: 'v2', snapshotVersion: 'v2', logVersion: 'v1' })).toEqual({
            ok: false,
            staleSnapshot: false,
            staleLog: true,
        });
    });

    it('flags both when both lag behind', () => {
        expect(verifyVersions({ truth: 'v2', snapshotVersion: 'v1', logVersion: 'v1' })).toEqual({
            ok: false,
            staleSnapshot: true,
            staleLog: true,
        });
    });

    it('never flags unknown versions', () => {
        expect(verifyVersions({ truth: '', snapshotVersion: 'v1', logVersion: 'v1' }).ok).toBe(true);
        expect(verifyVersions({ truth: 'v2', snapshotVersion: undefined, logVersion: undefined }).ok).toBe(true);
        expect(verifyVersions({ truth: 'v2', snapshotVersion: '', logVersion: '' }).ok).toBe(true);
    });
});
