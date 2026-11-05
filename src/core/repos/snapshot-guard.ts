/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** What the guard needs to know about a repository's snapshot. */
export interface SnapshotState {
    /** A snapshot exists at all. */
    hasSnapshot: boolean;
    /** The snapshot was built while the repository was focused (ancestors included). */
    builtFocused: boolean;
}

export interface FocusedSnapshotGuardOptions {
    /** Root of the repository the views currently show. */
    focusedRoot: () => string | undefined;
    /** Snapshot state of a repository, or `undefined` when it is not known yet. */
    probe: (root: string) => SnapshotState | undefined;
    /** Forces a fresh snapshot; may reject. */
    refresh: (root: string) => Promise<void>;
    /** Called after a refresh produced a usable snapshot. */
    onReady: () => void;
    /** Called with refresh failures so the host can log them instead of swallowing them. */
    onError?: (error: unknown, root: string) => void;
    /** Delay between retries. */
    delayMs?: number;
    /** Retries after the first attempt. */
    maxRetries?: number;
    schedule?: (task: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
}

const needsRefresh = (state: SnapshotState | undefined): boolean => !state?.hasSnapshot || !state.builtFocused;

/**
 * Makes sure the focused repository has a snapshot built while it was focused.
 *
 * A plain one-shot request is not enough: the refresh can fail while jj is busy, and no
 * further event may arrive afterwards (that left the Changes view empty until the user
 * switched repositories). This retries a bounded number of times instead.
 */
export class FocusedSnapshotGuard {
    private readonly _delayMs: number;
    private readonly _maxRetries: number;
    private readonly _schedule: (task: () => void, ms: number) => unknown;
    private readonly _cancel: (handle: unknown) => void;

    private _attempts = 0;
    private _inFlight = false;
    private _disposed = false;
    private _timer: unknown;

    constructor(private readonly _options: FocusedSnapshotGuardOptions) {
        this._delayMs = _options.delayMs ?? 400;
        this._maxRetries = _options.maxRetries ?? 3;
        this._schedule = _options.schedule ?? ((task, ms) => setTimeout(task, ms));
        this._cancel = _options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    /** Requests a snapshot if the focused repository has none or only an unfocused one. */
    run(): void {
        if (this._disposed || this._inFlight) {
            return;
        }
        const root = this._options.focusedRoot();
        if (!root) {
            return;
        }
        if (!needsRefresh(this._options.probe(root))) {
            this._attempts = 0;
            return;
        }
        void this._attempt(root);
    }

    dispose(): void {
        this._disposed = true;
        if (this._timer !== undefined) {
            this._cancel(this._timer);
            this._timer = undefined;
        }
    }

    private async _attempt(root: string): Promise<void> {
        this._inFlight = true;
        try {
            await this._options.refresh(root);
        } catch (error: unknown) {
            this._options.onError?.(error, root);
        } finally {
            this._inFlight = false;
        }
        if (this._disposed) {
            return;
        }

        if (!needsRefresh(this._options.probe(root))) {
            this._attempts = 0;
            this._options.onReady();
            return;
        }

        if (this._attempts >= this._maxRetries) {
            return;
        }
        this._attempts += 1;
        this._timer = this._schedule(() => {
            this._timer = undefined;
            this.run();
        }, this._delayMs);
    }
}
