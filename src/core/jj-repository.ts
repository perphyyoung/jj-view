/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import { DebouncingQueue } from '../utils/debouncing-queue';
import type { LoggerChannel } from '../utils/output-channel';
import { ChangeDetectionManager } from './change-detection-manager';
import { AsyncEventEmitter, type Disposable } from './host/events';
import type { HostEnvironment } from './host/host-environment';
import type { JjProcessTracker } from './jj-process-tracker';
import { JjService } from './jj-service';
import { composeOpHeadsVersion } from './repos/op-heads-version';
import type { Uri } from './uri-utils';

interface RefreshPayload {
    forceSnapshot: boolean;
    reasons: Set<string>;
    /** Repository state version the refresh was requested for. */
    version?: string;
}

export class JjRepository implements Disposable {
    private readonly _jj: JjService;
    private readonly _watcher: ChangeDetectionManager;
    private readonly _onDidStatusChange = new AsyncEventEmitter<{ reason: string; version?: string }>();
    /** Version of the last completed refresh; used to skip no-op op_heads events. */
    private _lastVersion = '';
    private readonly _outputChannel: LoggerChannel;
    private readonly _refreshQueue: DebouncingQueue<RefreshPayload>;

    readonly onDidStatusChange = this._onDidStatusChange.event;

    constructor(
        public readonly rootUri: Uri,
        public readonly storePath: string,
        outputChannel: LoggerChannel,
        public readonly host: HostEnvironment,
        binaryPath?: string,
        processTracker?: JjProcessTracker,
        /** Roots of repositories nested inside this one; their metadata is not watched. */
        getNestedRepositoryRoots?: () => readonly string[],
    ) {
        this._outputChannel = outputChannel;
        this._jj = new JjService(rootUri.fsPath, outputChannel, {
            binaryPath,
            getConfig: (key, defaultValue) => host.config.get(key, defaultValue),
            processTracker,
            system: host.system,
        });
        this._refreshQueue = new DebouncingQueue<RefreshPayload>(
            async (options) => {
                const reasonsSet = options?.reasons ?? new Set<string>();
                const reason = Array.from(reasonsSet).join(', ') || 'unknown';
                const start = performance.now();

                this._isValid = undefined;
                try {
                    await this._jj.clearCache();
                    if (options?.forceSnapshot) {
                        await this._jj.status();
                    }
                    await this._jj.getRepoRoot(); // Warm the cache

                    const duration = performance.now() - start;
                    outputChannel.info?.(
                        `[timing] [Snapshot] refresh took ${duration.toFixed(0)}ms (reason: ${reason})`,
                    );

                    if (options?.version) {
                        this._lastVersion = options.version;
                    }

                    if (!this._disposed) {
                        await this._onDidStatusChange.fire({ reason, version: options?.version });
                    }
                } catch (err) {
                    if (!this._disposed) {
                        throw err;
                    }
                }
            },
            {
                // Non-focused repositories only feed the Repositories view counts, so their
                // events are coalesced over a longer window than the focused one.
                getDebounceMillis: () =>
                    this._isFocused
                        ? (host.config.get<number>('refreshDebounceMillis', 100) ?? 100)
                        : ChangeDetectionManager.NON_FOCUSED_DEBOUNCE_MS,
                getMaxMultiplier: () => host.config.get<number>('refreshDebounceMaxMultiplier', 4) ?? 4,
                mergePayloads: (prev, next) => ({
                    forceSnapshot: prev.forceSnapshot || next.forceSnapshot,
                    reasons: new Set([...prev.reasons, ...next.reasons]),
                    version: next.version ?? prev.version,
                }),
                logger: outputChannel,
            },
        );

        this._watcher = new ChangeDetectionManager(
            rootUri.fsPath,
            this._jj,
            outputChannel,
            async (options) => {
                const version = options?.checkVersion ? await this.getOpHeadsVersion() : undefined;
                if (version && version === this._lastVersion) {
                    this._outputChannel.info?.(`[Refresh] skip ${options?.reason ?? 'unknown'} (version unchanged)`);
                    return;
                }
                const payload: RefreshPayload = {
                    forceSnapshot: !!options?.forceSnapshot,
                    reasons: options?.reason ? new Set([options.reason]) : new Set(),
                    // A version-checked event (op_heads) already carries the state it wants.
                    version,
                };
                try {
                    await this._refreshQueue.push(payload);
                } catch {
                    // Background change detection refreshes log errors via the queue logger.
                }
            },
            host,
            undefined,
            () => this._isFocused,
            getNestedRepositoryRoots,
        );
    }

    private _isFocused = true;

    /** Updated by the repository manager whenever the focused repository changes. */
    public setFocused(focused: boolean): void {
        this._isFocused = focused;
    }

    get isFocused(): boolean {
        return this._isFocused;
    }

    get activeRefresh(): Promise<void> | undefined {
        return this._refreshQueue.currentRun;
    }

    get jj(): JjService {
        return this._jj;
    }

    get watcher(): ChangeDetectionManager {
        return this._watcher;
    }

    private _disposed = false;
    private _isValid: boolean | undefined;
    async isValid(): Promise<boolean> {
        if (this._isValid !== undefined) {
            return this._isValid;
        }
        const hostFs = this.host.system?.fs;
        if (!hostFs) {
            this._isValid = false;
            return false;
        }
        this._isValid = await hostFs.exists(path.join(this.rootUri.fsPath, '.jj', 'working_copy', 'type'));
        return this._isValid;
    }

    /**
     * Reads the repository state version from `.jj/repo/store/op_heads/heads`.
     *
     * Pure file listing: no jj spawn, and every jj operation (ours included) updates it, so
     * it is the cheapest reliable way to tell "the state really changed".
     */
    async getOpHeadsVersion(): Promise<string> {
        const fs = this.host.system?.fs;
        if (!fs) {
            return '';
        }
        try {
            const names = await fs.readdir(path.join(this.storePath, 'op_heads', 'heads'));
            return composeOpHeadsVersion(names);
        } catch {
            return '';
        }
    }

    async refresh(options: { forceSnapshot?: boolean; reason?: string; checkVersion?: boolean } = {}): Promise<void> {
        if (this._disposed) {
            return;
        }
        const version = options.checkVersion ? await this.getOpHeadsVersion() : undefined;
        if (version && version === this._lastVersion) {
            // Nothing changed since the last applied snapshot (typically our own command,
            // whose op_heads event arrives after the explicit refresh already ran).
            this._outputChannel.info?.(`[Refresh] skip ${options.reason ?? 'unknown'} (version unchanged)`);
            return;
        }
        const payload: RefreshPayload = {
            forceSnapshot: !!options.forceSnapshot,
            reasons: options.reason ? new Set([options.reason]) : new Set(),
            version,
        };
        this._refreshQueue.push(payload);
        return this._refreshQueue.flush();
    }

    async awaitWatchersReady(): Promise<void> {
        await this._watcher.awaitWatchersReady();
    }

    async dispose(): Promise<void> {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._refreshQueue.dispose();
        await this._watcher.dispose();
        this._onDidStatusChange.dispose();

        const activeRun = this._refreshQueue.currentRun;
        if (activeRun) {
            try {
                await activeRun;
            } catch {
                // Ignore any error during dispose
            }
        }
    }
}
