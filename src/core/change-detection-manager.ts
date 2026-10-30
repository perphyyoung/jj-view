/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackendType } from '@parcel/watcher';
import path from 'pathe';
import { toError } from '../utils/error-utils';
import type { LoggerChannel } from '../utils/output-channel';
import { DirectoryWatcher } from './directory-watcher';
import type { HostDisposable, HostEnvironment } from './host/host-environment';
import type { JjService } from './jj-service';
import { Poller } from './poller';

/** A single ignore rule parsed from `.gitignore`, `info/exclude` or a global excludes file. */
interface IgnoreRule {
    /** POSIX-style directory the rule is relative to (`''` for the repository root). */
    baseDir: string;
    /** Pattern with wildcards stripped (the watcher only supports literal paths). */
    literal: string;
    negated: boolean;
}

export class ChangeDetectionManager implements HostDisposable {
    private _disposed = false;
    private disposables: HostDisposable[] = [];

    private _workingCopyWatcher: DirectoryWatcher | undefined;
    private _opHeadsWatcher: DirectoryWatcher | undefined;
    private _lifecyclePromise: Promise<void> = Promise.resolve();
    private _poller: Poller;
    private _fileWatcherMode: 'polling' | 'watch' = 'polling';
    private _isActive = true;
    private lastExternalOpTime = 0;
    private _lastActiveRefreshTime = 0;
    private _deferredRefreshTimeout: NodeJS.Timeout | undefined;
    private _watchersWarmedUp = false;

    /** Throttle interval in milliseconds to prevent excessive repository snapshots on rapid window active events. */
    public static readonly ACTIVE_REFRESH_THROTTLE_MS = 10000;
    public static readonly FOCUS_REFRESH_THROTTLE_MS = ChangeDetectionManager.ACTIVE_REFRESH_THROTTLE_MS;

    /**
     * Window after one of our own jj commands during which `op_heads` changes are treated
     * as self-produced. jj snapshots the working copy (creating an operation) for every
     * command, including read-only `jj status` / `jj log`, so reacting to our own op would
     * schedule a redundant second refresh for a single edit.
     */
    public static readonly SELF_OP_SUPPRESS_MS = 1500;

    /** True when an `op_heads` change was most likely written by a jj command we started. */
    private isSelfProducedOpHeadsEvent(): boolean {
        return (
            this.jj.hasActiveWriteOps || Date.now() - this.jj.lastWriteTime < ChangeDetectionManager.SELF_OP_SUPPRESS_MS
        );
    }

    private async _runLifecycleTask(task: () => Promise<void>): Promise<void> {
        this._lifecyclePromise = this._lifecyclePromise
            .catch(() => {})
            .then(async () => {
                await task();
            });
        return this._lifecyclePromise;
    }

    private get hasActiveOrRecentWrites(): boolean {
        return (
            this.jj.hasActiveWriteOps ||
            Date.now() - this.jj.lastWriteTime < 500 ||
            Date.now() - this.lastExternalOpTime < 500
        );
    }

    private _pendingForceSnapshot = false;

    private _scheduleDeferredRefresh(forceSnapshot = false) {
        this._pendingForceSnapshot = this._pendingForceSnapshot || forceSnapshot;
        if (this._deferredRefreshTimeout) {
            return;
        }
        this._deferredRefreshTimeout = setTimeout(() => {
            this._deferredRefreshTimeout = undefined;
            if (this._disposed) {
                return;
            }
            const writes = this.hasActiveOrRecentWrites;
            if (writes) {
                this._scheduleDeferredRefresh();
            } else {
                this.lastExternalOpTime = Date.now();
                const force = this._pendingForceSnapshot;
                this._pendingForceSnapshot = false;
                this.triggerRefresh({ forceSnapshot: force, reason: 'deferred watcher event' });
            }
        }, 500);
    }

    constructor(
        private workspaceRoot: string,
        private jj: JjService,
        private outputChannel: LoggerChannel,
        private triggerRefresh: (event: { forceSnapshot: boolean; reason: string }) => Promise<void>,
        private readonly host: HostEnvironment,
        private readonly watcherBackend?: BackendType,
        /** Only the focused repository refreshes when the window becomes active. */
        private readonly isFocused: () => boolean = () => true,
    ) {
        // Initialize poller with 5 second interval
        this._poller = new Poller(5000, async () => {
            // Skip if a write operation is in progress or just finished
            if (!this.hasActiveOrRecentWrites) {
                await this.triggerRefresh({ forceSnapshot: true, reason: 'poll' });
            }
        });

        // 1. Watch for editor saves (catches user edits in host)
        if (this.host.documents.onDidSaveDocument) {
            this.disposables.push(
                this.host.documents.onDidSaveDocument((uri) => {
                    if (this._disposed) {
                        return;
                    }
                    if (uri.scheme !== 'file') {
                        return;
                    }
                    const { fsPath } = uri;
                    if (/[\\/]\.jj[\\/]/.test(fsPath)) {
                        return;
                    }
                    const relative = path.relative(this.workspaceRoot, fsPath);
                    if (relative.startsWith('..') || path.isAbsolute(relative)) {
                        return;
                    }
                    this.triggerRefresh({ forceSnapshot: true, reason: 'file saved' });
                }),
            );
        }

        // 2. Poll for external changes or start main watcher
        // Listen for window state changes to pause/resume polling if in polling mode
        this._isActive = this.host.ui.isActive ?? this.host.ui.isFocused ?? true;
        const activeChangeEvent = this.host.ui.onDidChangeActive ?? this.host.ui.onDidChangeFocus;
        if (activeChangeEvent) {
            this.disposables.push(
                activeChangeEvent((active) => {
                    this.onWindowStateChange(active);
                }),
            );
        }

        // Listen for configuration changes
        if (this.host.config.onDidChangeConfiguration) {
            this.disposables.push(
                this.host.config.onDidChangeConfiguration(async (e) => {
                    if (e.affectsConfiguration('jj-view.fileWatcherMode')) {
                        await this.updateFileWatcherMode();
                    }
                }),
            );
        }

        // Initialize watchers synchronously
        this._lifecyclePromise = Promise.all([this.startOpHeadsWatcher(), this.updateFileWatcherModeInternal()])
            .then(() => {})
            .catch((err) => {
                this.outputChannel.error(`[ChangeDetectionManager] Error during initialization: ${err}`);
            });
    }

    public async awaitWatchersReady(): Promise<void> {
        await this._lifecyclePromise.catch(() => {});
        if (this._fileWatcherMode === 'watch' && !this._watchersWarmedUp) {
            // Give the OS/file system a brief moment to fully register and warm up the new watches
            await new Promise((resolve) => setTimeout(resolve, 50));
            this._watchersWarmedUp = true;
        }
    }

    private async updateFileWatcherMode() {
        return this._runLifecycleTask(async () => {
            await this.updateFileWatcherModeInternal();
        });
    }

    private async updateFileWatcherModeInternal() {
        if (this._disposed) {
            return;
        }
        const mode = this.host.config.get<'polling' | 'watch'>('fileWatcherMode', 'polling') ?? 'polling';
        this.outputChannel.debug(`[ChangeDetectionManager] File watcher mode: ${mode}`);

        const modeChanged = this._fileWatcherMode !== mode;
        this._fileWatcherMode = mode;

        if (modeChanged) {
            await this.stopWorkingCopyWatchingInternal();
            await this.startWorkingCopyWatchingInternal();
        }

        // Always ensure polling state is correct
        this.updatePollingState();
    }

    private onWindowStateChange(active: boolean): void {
        if (this._disposed) {
            return;
        }
        this._isActive = active;
        this.updatePollingState();

        if (!active) {
            return;
        }

        if (!this.isFocused()) {
            return;
        }

        const now = Date.now();
        if (now - this._lastActiveRefreshTime <= ChangeDetectionManager.ACTIVE_REFRESH_THROTTLE_MS) {
            return;
        }

        if (this.hasActiveOrRecentWrites) {
            this._scheduleDeferredRefresh(true);
            return;
        }

        this._lastActiveRefreshTime = now;
        this.triggerRefresh({ forceSnapshot: true, reason: 'active refresh' }).catch((err: unknown) => {
            this.outputChannel.error?.(`[ChangeDetectionManager] Active refresh failed: ${err}`);
        });
    }

    /**
     * Reconciles the polling state based on current mode, active state, and disposal status.
     * Starts or stops the poller accordingly.
     */
    private updatePollingState(): void {
        // If not in polling mode, or not active, or disposed -> Stop
        if (this._fileWatcherMode !== 'polling' || !this._isActive || this._disposed) {
            this._poller.stop();
            return;
        }

        // We are in polling mode and active.
        this._poller.start();
    }

    private async startOpHeadsWatcher() {
        if (this._disposed) {
            return;
        }
        if (this._opHeadsWatcher) {
            return;
        }

        let retries = 0;
        const maxRetries = 25; // 5 seconds total (25 * 200ms)
        let lastErr: unknown;

        while (retries < maxRetries && !this._disposed) {
            try {
                await this.jj.getRepoRoot();

                // Handle non-default workspaces where .jj/repo might be a file containing a path
                const repoStorePath = await this.jj.getRepoStorePath();
                if (this._disposed) {
                    return;
                }

                const opHeadsPath = path.join(repoStorePath, 'op_heads');

                // Final check that the directory exists and we have a real path
                const hostFs = this.host.system?.fs;
                const realOpHeadsPath = hostFs ? await hostFs.realpath(opHeadsPath) : opHeadsPath;

                if (this._disposed) {
                    return;
                }

                this._opHeadsWatcher = new DirectoryWatcher(
                    realOpHeadsPath,
                    () => {
                        if (this.isSelfProducedOpHeadsEvent()) {
                            return;
                        }
                        const writes = this.hasActiveOrRecentWrites;
                        if (writes) {
                            this._scheduleDeferredRefresh();
                            return;
                        }
                        this.lastExternalOpTime = Date.now();
                        this.triggerRefresh({ forceSnapshot: false, reason: 'jj operation' });
                    },
                    this.outputChannel,
                    {
                        name: 'OpHeads Watcher',
                        backend: this.watcherBackend,
                        host: this.host,
                        onReconnect: () => {
                            if (this._disposed) {
                                return;
                            }
                            const writes = this.hasActiveOrRecentWrites;
                            if (writes) {
                                this._scheduleDeferredRefresh();
                                return;
                            }
                            this.triggerRefresh({ forceSnapshot: false, reason: 'op_heads watcher reconnected' });
                        },
                        onPermanentFailure: (err) => {
                            this.outputChannel.error(
                                '[ChangeDetectionManager] OpHeads watcher permanently failed',
                                toError(err),
                            );
                            void this._opHeadsWatcher?.stop().catch(() => {});
                            this._opHeadsWatcher = undefined;
                        },
                    },
                );
                await this._opHeadsWatcher.start();
                return; // Success
            } catch (err) {
                if (this._disposed) {
                    return;
                }
                this.outputChannel.error(
                    `[Error] [ChangeDetectionManager] startOpHeadsWatcher retry ${retries} failed for path ${this.workspaceRoot}: ${err instanceof Error ? err.stack : err}`,
                );
                lastErr = err;
                retries++;
                if (retries < maxRetries && !this._disposed) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }
        }

        if (!this._disposed) {
            this.outputChannel.error(`Failed to setup op_heads watcher after ${maxRetries} retries: ${lastErr}`);
        }
    }

    private async startWorkingCopyWatchingInternal() {
        if (this._disposed) {
            return;
        }
        if (this._fileWatcherMode === 'watch') {
            await this.startWorkingCopyWatcherInternal().catch((err) => {
                this.outputChannel.error(`Failed to start working copy watcher: ${err}`);
                this.outputChannel.info('Falling back to polling mode.');
                this._fileWatcherMode = 'polling';
                this.updatePollingState();
            });
        } else {
            this.updatePollingState();
        }
    }

    private async stopWorkingCopyWatchingInternal() {
        // Also stop polling if it was active
        this._poller.stop();

        if (this._workingCopyWatcher) {
            await this._workingCopyWatcher.stop();
            this._workingCopyWatcher = undefined;
        }
    }

    private async startWorkingCopyWatcherInternal() {
        if (this._disposed) {
            return;
        }
        if (this._workingCopyWatcher) {
            return;
        }

        const [gitIgnores, gitModules, workspaceRoots] = await Promise.all([
            this.getGitIgnorePatterns(),
            this.getGitModulesPatterns(),
            this.getSecondaryWorkspacePatterns(),
        ]);
        if (this._disposed || this._fileWatcherMode !== 'watch') {
            return;
        }

        const ignore = ['.git', '.jj', '.vscode-test', 'node_modules', ...gitIgnores, ...gitModules, ...workspaceRoots];
        this.outputChannel.debug(`[ChangeDetectionManager] Watcher ignore list: ${JSON.stringify(ignore)}`);

        this._workingCopyWatcher = new DirectoryWatcher(
            this.workspaceRoot,
            () => {
                const writes = this.hasActiveOrRecentWrites;
                if (writes) {
                    this._scheduleDeferredRefresh(true);
                    return;
                }
                this.triggerRefresh({ forceSnapshot: true, reason: 'file watcher event' });
            },
            this.outputChannel,
            {
                name: 'Working Copy Watcher',
                backend: this.watcherBackend,
                host: this.host,
                onReconnect: () => {
                    if (this._disposed) {
                        return;
                    }
                    const writes = this.hasActiveOrRecentWrites;
                    if (writes) {
                        this._scheduleDeferredRefresh(true);
                        return;
                    }
                    this.triggerRefresh({ forceSnapshot: true, reason: 'file watcher reconnected' });
                },
                onPermanentFailure: (err) => {
                    this.outputChannel.error(
                        '[ChangeDetectionManager] Working copy watcher permanently failed',
                        toError(err),
                    );
                    this.outputChannel.info('Falling back to polling mode.');
                    this._fileWatcherMode = 'polling';
                    void this._workingCopyWatcher?.stop().catch(() => {});
                    this._workingCopyWatcher = undefined;
                    this.updatePollingState();
                },
            },
        );

        this.outputChannel.info(
            `[ChangeDetectionManager] Starting Working Copy Watcher on ${this.workspaceRoot} with backend: ${this.watcherBackend}`,
        );

        await this._workingCopyWatcher.start(ignore);
    }

    private async getSecondaryWorkspacePatterns(): Promise<string[]> {
        try {
            const hostFs = this.host.system?.fs;
            const workspaceList = await this.jj.getWorkspaces();
            this.outputChannel.info(`[ChangeDetectionManager] Workspaces retrieved: ${JSON.stringify(workspaceList)}`);
            const patterns: string[] = [];
            const rootReal = hostFs
                ? await hostFs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot)
                : this.workspaceRoot;

            for (const ws of workspaceList) {
                const wsReal = hostFs ? await hostFs.realpath(ws.path).catch(() => ws.path) : ws.path;
                if (wsReal !== rootReal) {
                    const relative = path.relative(rootReal, wsReal);
                    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                        patterns.push(relative);
                    }
                }
            }
            return patterns;
        } catch (err) {
            this.outputChannel.error(`[ChangeDetectionManager] getSecondaryWorkspacePatterns error: ${err}`);
            return [];
        }
    }

    /**
     * Version control metadata is never part of the working copy, so these directories are
     * skipped unconditionally. Every other directory (node_modules, dist, ...) is decided by
     * the repository's own ignore rules — there is no hardcoded pattern list.
     */
    private static readonly VCS_META_DIRS = new Set(['.git', '.jj']);

    /** Safety valve for pathological trees; deeper directories are not scanned for ignore files. */
    private static readonly IGNORE_SCAN_MAX_DEPTH = 8;

    /**
     * Collects ignore patterns from every source git itself honors: the root and
     * nested `.gitignore` files, `.git/info/exclude`, and the global excludes file.
     * Nested rules are gathered while walking the tree, and directories that the
     * already-collected rules ignore are pruned instead of scanned.
     */
    private async getGitIgnorePatterns(): Promise<string[]> {
        try {
            const hostFs = this.host.system?.fs;
            if (!hostFs) {
                return [];
            }

            const rootRules: IgnoreRule[] = [];

            const rootIgnore = path.join(this.workspaceRoot, '.gitignore');
            if (await hostFs.exists(rootIgnore)) {
                rootRules.push(...this.parseIgnoreRules(await hostFs.readTextFile(rootIgnore).catch(() => ''), ''));
            }

            const infoExclude = path.join(this.workspaceRoot, '.git', 'info', 'exclude');
            if (await hostFs.exists(infoExclude)) {
                rootRules.push(...this.parseIgnoreRules(await hostFs.readTextFile(infoExclude).catch(() => ''), ''));
            }

            for (const globalExclude of await this.getGlobalExcludeFiles()) {
                if (await hostFs.exists(globalExclude)) {
                    rootRules.push(
                        ...this.parseIgnoreRules(await hostFs.readTextFile(globalExclude).catch(() => ''), ''),
                    );
                }
            }

            const nestedRules: IgnoreRule[] = [];
            await this.collectNestedIgnoreRules(this.workspaceRoot, rootRules, 0, nestedRules);

            // @parcel/watcher cannot express negated patterns, so only positive literals are passed on.
            const patterns = [...rootRules, ...nestedRules]
                .filter((rule) => !rule.negated)
                .map((rule) => (rule.baseDir ? `${rule.baseDir}/${rule.literal}` : rule.literal));

            return [...new Set(patterns)];
        } catch (err) {
            this.outputChannel.error(`[ChangeDetectionManager] getGitIgnorePatterns error: ${err}`);
            return [];
        }
    }

    private parseIgnoreRules(content: string, baseDir: string): IgnoreRule[] {
        const rules: IgnoreRule[] = [];
        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }

            const negated = line.startsWith('!');
            // PARCEL-WATCHER BEHAVIOR:
            // 1. Literal paths (e.g. 'out') prune all descendants recursively.
            // 2. Glob patterns (e.g. 'out*') do NOT prune descendants recursively.
            //
            // By stripping wildcards we ensure directory contents are ignored, which is the common case
            // for gitignore patterns like /out/. The caveat is that we lose true wildcard matching
            // (e.g. /out*/ will only match a directory named exactly 'out').
            const literal = (negated ? line.slice(1) : line).replace(/^[/*?]+|[/*?]+$/g, '');
            if (!literal) {
                continue;
            }
            rules.push({ baseDir, literal, negated });
        }
        return rules;
    }

    /** Mirrors git semantics: the last matching rule wins, and a directory match covers its subtree. */
    private isIgnored(relativePath: string, rules: readonly IgnoreRule[]): boolean {
        const normalized = relativePath.replace(/\\/g, '/');
        for (let i = rules.length - 1; i >= 0; i--) {
            const rule = rules[i];
            const target = rule.baseDir ? `${rule.baseDir}/${rule.literal}` : rule.literal;
            if (normalized === target || normalized.startsWith(`${target}/`)) {
                return !rule.negated;
            }
        }
        return false;
    }

    private async collectNestedIgnoreRules(
        dir: string,
        inherited: readonly IgnoreRule[],
        depth: number,
        out: IgnoreRule[],
    ): Promise<void> {
        const hostFs = this.host.system?.fs;
        if (!hostFs || depth >= ChangeDetectionManager.IGNORE_SCAN_MAX_DEPTH) {
            return;
        }

        let entries: string[];
        try {
            entries = await hostFs.readdir(dir);
        } catch {
            return;
        }

        for (const name of entries) {
            if (ChangeDetectionManager.VCS_META_DIRS.has(name)) {
                continue;
            }

            const fullPath = path.join(dir, name);
            try {
                if (!(await hostFs.lstat(fullPath)).isDirectory()) {
                    continue;
                }
            } catch {
                continue;
            }

            const relativeDir = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
            if (this.isIgnored(relativeDir, inherited)) {
                continue;
            }

            const rules: IgnoreRule[] = [...inherited];
            const ignoreFile = path.join(fullPath, '.gitignore');
            if (await hostFs.exists(ignoreFile)) {
                const nested = this.parseIgnoreRules(
                    await hostFs.readTextFile(ignoreFile).catch(() => ''),
                    relativeDir,
                );
                rules.push(...nested);
                out.push(...nested);
            }

            await this.collectNestedIgnoreRules(fullPath, rules, depth + 1, out);
        }
    }

    /** Global git ignore files: `core.excludesFile` (if configured) plus the XDG default. */
    private async getGlobalExcludeFiles(): Promise<string[]> {
        const files: string[] = [];
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const system = this.host.system;
        if (!system) {
            return files;
        }

        try {
            const result = await system.process.execFile('git', ['config', '--get', 'core.excludesFile']);
            const configured = result.stdout.trim();
            if (configured) {
                const expanded = configured.startsWith('~')
                    ? path.join(home, configured.replace(/^~[\\/]?/, ''))
                    : configured;
                files.push(expanded);
            }
        } catch {
            // git not installed or core.excludesFile not configured
        }

        if (home) {
            files.push(path.join(home, '.config', 'git', 'ignore'));
        }
        return [...new Set(files)];
    }

    private async getGitModulesPatterns(): Promise<string[]> {
        try {
            const hostFs = this.host.system?.fs;
            if (!hostFs) {
                return [];
            }
            const gitModulesPath = path.join(this.workspaceRoot, '.gitmodules');
            const data = await hostFs.readTextFile(gitModulesPath);
            const paths: string[] = [];

            const lines = data.split('\n');
            for (const line of lines) {
                const match = line.match(/^\s*path\s*=\s*(.+)$/);
                if (match) {
                    paths.push(match[1].trim());
                }
            }
            return paths;
        } catch {
            return [];
        }
    }

    async dispose(): Promise<void> {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._pendingForceSnapshot = false;

        this.disposables.forEach((d) => {
            d.dispose();
        });
        this.disposables = [];

        if (this._deferredRefreshTimeout) {
            clearTimeout(this._deferredRefreshTimeout);
            this._deferredRefreshTimeout = undefined;
        }

        // Run the teardown in the lifecycle queue to serialize after active watcher transitions
        await this._runLifecycleTask(async () => {
            this._poller.stop();

            if (this._workingCopyWatcher) {
                await this._workingCopyWatcher.dispose();
                this._workingCopyWatcher = undefined;
            }

            this._poller.dispose();

            if (this._opHeadsWatcher) {
                await this._opHeadsWatcher.dispose();
                this._opHeadsWatcher = undefined;
            }
        });
    }
}
