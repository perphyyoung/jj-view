/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { verifyVersions } from './state-invariants';

/** One repository the coordinator can verify and repair. */
export interface VerifiableState {
    root: string;
    /** Repository truth: the current `op_heads` version. */
    truth: () => Promise<string>;
    /** Version of the SCM snapshot currently used by Changes and the Repos counts. */
    snapshotVersion: () => string | undefined;
    /** Version of the JJ Log data, when that view exists for this repository. */
    logVersion?: () => string | undefined;
    /** Recomputes the snapshot; resolves when the refresh was requested. */
    repairSnapshot: () => Promise<void>;
    /** Re-queries the log. */
    repairLog?: () => Promise<void>;
}

export interface StateCoordinatorOptions {
    /** Minimum time between two repairs of the same repository. */
    cooldownMs?: number;
    now?: () => number;
    onError?: (message: string, error?: unknown) => void;
}

/**
 * Keeps the three views on the same repository state.
 *
 * Every view stamps its data with the `op_heads` version it was computed from; this compares
 * those stamps with the version on disk and repairs only the stale side. It never looks at
 * the webviews, so it also runs while a view is closed or not yet resolved.
 */
export class StateCoordinator {
    private readonly _cooldownMs: number;
    private readonly _now: () => number;
    private readonly _onError?: (message: string, error?: unknown) => void;
    private readonly _repairedAt = new Map<string, number>();

    constructor(options: StateCoordinatorOptions = {}) {
        this._cooldownMs = options.cooldownMs ?? 1000;
        this._now = options.now ?? Date.now;
        this._onError = options.onError;
    }

    /** Returns the repositories whose data no longer matches the repository truth. */
    async findStale(repos: readonly VerifiableState[]): Promise<VerifiableState[]> {
        const stale: VerifiableState[] = [];
        for (const repo of repos) {
            try {
                const truth = await repo.truth();
                const check = verifyVersions({
                    truth,
                    snapshotVersion: repo.snapshotVersion(),
                    logVersion: repo.logVersion?.(),
                });
                if (!check.ok) {
                    stale.push(repo);
                }
            } catch (error: unknown) {
                this._onError?.(`[Consistency] Failed to verify ${repo.root}`, error);
            }
        }
        return stale;
    }

    /**
     * Verifies every repository and repairs the stale ones, at most once per cooldown.
     * Returns the roots that were repaired.
     */
    async verifyAndRepair(repos: readonly VerifiableState[], reason: string): Promise<string[]> {
        const stale = await this.findStale(repos);
        const repaired: string[] = [];
        for (const repo of stale) {
            const last = this._repairedAt.get(repo.root);
            if (last !== undefined && this._now() - last < this._cooldownMs) {
                continue;
            }
            this._repairedAt.set(repo.root, this._now());
            try {
                // Both sides are refreshed: the snapshot feeds Changes and the Repos counts,
                // the log is queried separately, and either can be the stale one.
                await repo.repairSnapshot();
                await repo.repairLog?.();
                repaired.push(repo.root);
                this._onError?.(`[Consistency] Repaired ${repo.root} (${reason})`);
            } catch (error: unknown) {
                this._onError?.(`[Consistency] Repair failed for ${repo.root} (${reason})`, error);
            }
        }
        return repaired;
    }
}
