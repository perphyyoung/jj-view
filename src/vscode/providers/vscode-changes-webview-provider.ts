/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitResult } from '../../core/commands/commit';
import { ScmContextValue } from '../../core/jj-context-keys';
import type { JjRepository } from '../../core/jj-repository';
import type { JjRepositoryManager } from '../../core/jj-repository-manager';
import type { JjStatusEntry } from '../../core/jj-types';
import { FocusedSnapshotGuard } from '../../core/repos/snapshot-guard';
import {
    DEFAULT_REPO_SORT,
    isRepoSortKey,
    REPO_SORT_KEYS,
    REPO_SORT_LABELS,
    REPO_SORT_SHORT_LABELS,
    type RepoSortKey,
    sortRepos,
} from '../../core/repos/sort-repos';
import type { ScmModel, ScmSnapshot } from '../../core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../core/scm-resource-state';
import type { Uri } from '../../core/uri-utils';
import type { LoggerChannel } from '../../utils/output-channel';
import { runWithConcurrency } from '../../utils/run-with-concurrency';
import { getWebviewHtml } from '../vscode-webview-html';
import type { VsCodeScmProvider } from './vscode-scm-provider';

/** Snapshot shape sent to the changes webview (Map fields are dropped). */
export type ChangesWireSnapshot = Omit<ScmSnapshot, 'workingCopyStatuses'>;

/** Minimal description of a changed file, enough to rebuild a JjResourceState. */
export interface ChangesWireResourceState {
    path: string;
    revision: string;
    status?: JjStatusEntry['status'];
    conflicted?: boolean;
    contextValue?: string;
}

export interface ChangesWireRepoSummary {
    root: string;
    name: string;
    /** `undefined` while the snapshot is still unknown (cold start). */
    changeCount?: number;
    conflictCount: number;
    /** Committer timestamp of `@`; used by the Recent Commit ordering. */
    lastCommitAt?: string;
}

export type ChangesViewMode = 'repos' | 'changes';

type HostMessage =
    | { type: 'ready' }
    | { type: 'focusRepository'; payload: { root: string } }
    | { type: 'draft'; payload: { root: string; description: string } }
    | { type: 'open'; payload: { root: string; state: ChangesWireResourceState } }
    | {
          type: 'action';
          payload: {
              root: string;
              command: string;
              state?: ChangesWireResourceState;
              groupId?: string;
              /** Tree folder: untrack every file under this repository-relative folder. */
              paths?: string[];
              /** Tree folder path, ignored as a whole so future files stay untracked. */
              folder?: string;
          };
      }
    | { type: 'commit'; payload: { root: string; description: string } }
    | { type: 'setDescription'; payload: { root: string; description: string } }
    | { type: 'refresh'; payload?: { root?: string } };

/**
 * Renders one of the two JJ activity bar views backed by the same webview bundle:
 *
 * - `repos`: the repository list (one row per repository/workspace, with counts).
 * - `changes`: the working copy panel of the focused repository only.
 *
 * The provider is a thin adapter: it aggregates existing `ScmModel` snapshots and
 * forwards user actions to the already registered `jj-view.*` commands.
 */
export class VsCodeChangesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view?: vscode.WebviewView;
    private _disposed = false;
    /** Change ids the webview must expand on the next state push (one-shot, cleared when sent). */
    private _revealChangeIds: string[] = [];
    private readonly _disposables: vscode.Disposable[] = [];
    private _viewDisposables: vscode.Disposable[] = [];
    /**
     * Snapshot subscriptions carry the model they belong to. A provider can be recreated for
     * the same root, and a subscription kept for the old model would silently never fire.
     */
    private readonly _snapshotSubscriptions = new Map<string, { model: ScmModel; subscription: { dispose(): void } }>();
    private readonly _snapshotGuard: FocusedSnapshotGuard;
    private _viewMissingLogged = false;

    private static readonly VIEW_MODE_KEY = 'jj-view.changesViewMode';

    /** Session-only ordering: no persistence, so a reload starts from the default. */
    private _repoSortKey: RepoSortKey = DEFAULT_REPO_SORT;
    /** Monotonic push sequence; survives ScmModel instances, unlike the snapshot revision. */
    private _pushSeq = 0;
    /** Roots whose repository summary was already requested by the Repositories view. */
    private readonly _summaryRoots = new Set<string>();
    /** Bounded wait so a hung first scan never leaves the view on "Loading" forever. */
    private _initialLoadTimedOut = false;
    private _initialLoadTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly _extensionUri: Uri,
        private readonly _repositoryManager: JjRepositoryManager,
        private readonly _scmProviders: Map<string, VsCodeScmProvider>,
        private readonly _packageJson: { contributes?: unknown },
        private readonly _context: vscode.ExtensionContext,
        private readonly _mode: ChangesViewMode,
        private readonly _outputChannel?: LoggerChannel,
        /**
         * Creates the SCM provider for a repository when it does not exist yet. The view can
         * resolve before providers are registered (cold start), and without this the snapshot
         * subscription would silently never attach, leaving the view stale after a commit.
         */
        private readonly _ensureScmProvider?: (repo: JjRepository) => VsCodeScmProvider | undefined,
    ) {
        this._disposables.push(
            this._repositoryManager.onDidChangeRepositories(() =>
                this._guard('repositories changed', () => {
                    this._syncSnapshotSubscriptions();
                    this._postState();
                }),
            ),
            this._repositoryManager.onDidOpenRepository(() =>
                this._guard('repository opened', () => {
                    this._syncSnapshotSubscriptions();
                    this._postState();
                }),
            ),
            this._repositoryManager.onDidCloseRepository(() =>
                this._guard('repository closed', () => {
                    this._syncSnapshotSubscriptions();
                    this._postState();
                }),
            ),
            this._repositoryManager.onDidChangeFocusedRepository(() =>
                this._guard('focused repository changed', () => {
                    this._syncSnapshotSubscriptions();
                    this._postState();
                }),
            ),
        );

        this._snapshotGuard = new FocusedSnapshotGuard({
            focusedRoot: () => this._repositoryManager.focusedRepository?.rootUri.fsPath,
            probe: (root) => {
                const scm = this._scmProviders.get(root);
                if (!scm) {
                    return undefined;
                }
                return { hasSnapshot: Boolean(scm.scmModel.snapshot), builtFocused: scm.snapshotBuiltFocused };
            },
            refresh: async (root) => {
                const repo = this._findRepository(root);
                if (!repo) {
                    return;
                }
                const scm = this._scmProviders.get(root) ?? this._ensureScmProvider?.(repo);
                if (!scm) {
                    return;
                }
                await scm.refresh({ forceSnapshot: true, reason: 'focused snapshot guard' });
            },
            onReady: () => this._postState(),
            onError: (error: unknown, root: string) => {
                const err = error instanceof Error ? error : new Error(String(error));
                this._outputChannel?.error(`[ChangesView] Snapshot refresh failed for ${root}`, err);
            },
        });

        if (this._mode === 'changes') {
            void vscode.commands.executeCommand('setContext', 'jj.changesViewAsTree', this._viewMode === 'tree');
            this._disposables.push(
                vscode.commands.registerCommand('jj-view.changesAsTree', () => this._setViewMode('tree')),
                vscode.commands.registerCommand('jj-view.changesAsList', () => this._setViewMode('list')),
                vscode.commands.registerCommand('jj-view.revealChangesGroup', (args: unknown) =>
                    this._revealChangesGroup(args),
                ),
                vscode.commands.registerCommand('jj-view.refreshChanges', () => this._reloadChangesView()),
            );
        }

        if (this._mode === 'repos') {
            this._disposables.push(
                vscode.commands.registerCommand('jj-view.reposSort', (arg?: unknown) => this._pickRepoSort(arg)),
            );
        }

        this._initialLoadTimer = setTimeout(() => {
            this._initialLoadTimer = undefined;
            this._initialLoadTimedOut = true;
            this._postState();
        }, 8000);
    }

    /**
     * Toolbar refresh: clear the webview immediately, then reload the focused repository.
     * The explicit reset makes a slow or failed jj run visible instead of looking like a no-op.
     */
    private async _reloadChangesView(): Promise<void> {
        if (this._disposed) {
            return;
        }
        this._post({ type: 'reloading' });
        const root = this._repositoryManager.focusedRepository?.rootUri.fsPath;
        const repo = root ? this._findRepository(root) : undefined;
        const scm = root
            ? (this._scmProviders.get(root) ?? (repo ? this._ensureScmProvider?.(repo) : undefined))
            : undefined;
        try {
            if (scm) {
                await scm.refresh({ forceSnapshot: true, reason: 'changes view refresh' });
            } else {
                await vscode.commands.executeCommand('jj-view.refresh');
            }
        } catch (error: unknown) {
            this._outputChannel?.error(
                '[ChangesView] Refresh failed',
                error instanceof Error ? error : new Error(String(error)),
            );
        } finally {
            this._postState();
        }
    }

    /** True until the initial repository scan settles (or the bounded wait expires). */
    private _isReposLoading(): boolean {
        return (
            !this._initialLoadTimedOut &&
            !this._repositoryManager.isInitialScanComplete &&
            this._repositoryManager.repositories.length === 0
        );
    }

    /**
     * Expands the given change groups on the next state push. Used after a split so both the
     * source commit and the commit created next to it are visible.
     */
    private _revealChangesGroup(args: unknown): void {
        const payload = (args ?? {}) as { root?: string; changeIds?: string[] };
        const changeIds = (payload.changeIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
        if (changeIds.length === 0) {
            return;
        }
        if (payload.root) {
            this._focus(payload.root);
        }
        this._revealChangeIds = [...new Set([...this._revealChangeIds, ...changeIds])];
        this._postState();
    }

    /**
     * Repositories title-bar action: pick how the rows are ordered. An explicit key is
     * accepted so the same command works from the palette and from tests.
     */
    private async _pickRepoSort(arg?: unknown): Promise<void> {
        if (isRepoSortKey(arg)) {
            this._setRepoSort(arg);
            return;
        }
        const current = this._repoSortKey;
        const items = REPO_SORT_KEYS.map((key) => ({
            label: REPO_SORT_LABELS[key],
            iconPath: key === current ? new vscode.ThemeIcon('check') : undefined,
            picked: key === current,
            key,
        }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Sort repositories by…' });
        if (picked) {
            this._setRepoSort(picked.key);
        }
    }

    private _setRepoSort(key: RepoSortKey): void {
        this._repoSortKey = key;
        this._updateTitle();
        this._postState();
    }

    private get _viewMode(): 'list' | 'tree' {
        return this._context.globalState.get<'list' | 'tree'>(VsCodeChangesWebviewProvider.VIEW_MODE_KEY, 'list');
    }

    private _setViewMode(mode: 'list' | 'tree'): void {
        void this._context.globalState.update(VsCodeChangesWebviewProvider.VIEW_MODE_KEY, mode);
        void vscode.commands.executeCommand('setContext', 'jj.changesViewAsTree', mode === 'tree');
        this._postState();
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._clearViewDisposables();
        this._view = webviewView;
        this._viewMissingLogged = false;
        this._updateTitle();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri as unknown as vscode.Uri],
        };
        // Send the initial state immediately as well as on `ready` / visibility change: the
        // handshake can lose the `ready` message when it arrives before this listener exists.
        this._postInit();

        webviewView.webview.html = getWebviewHtml({
            webview: webviewView.webview,
            extensionUri: this._extensionUri,
            scriptPath: ['dist', 'webview', 'changes.js'],
            title: this._mode === 'repos' ? 'JJ Repositories' : 'JJ Changes',
            // The view mode is baked into the HTML so the webview renders the right tree even
            // if the `ready`/`init` handshake loses a message (the webview used to default to
            // the changes layout, which made the Repositories view render ScmPane).
            initialData: { mode: this._mode },
        });

        this._viewDisposables.push(
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this._clearViewDisposables();
            }),
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this._syncSnapshotSubscriptions();
                    this._postInit();
                }
            }),
            webviewView.webview.onDidReceiveMessage((message: unknown) =>
                this._guard('handle message', () => this._handleMessage(message as HostMessage)),
            ),
        );

        this._syncSnapshotSubscriptions();
        this._postInit();
    }

    public dispose(): void {
        this._disposed = true;
        if (this._initialLoadTimer !== undefined) {
            clearTimeout(this._initialLoadTimer);
            this._initialLoadTimer = undefined;
        }
        this._snapshotGuard.dispose();
        this._clearViewDisposables();
        for (const entry of this._snapshotSubscriptions.values()) {
            entry.subscription.dispose();
        }
        this._snapshotSubscriptions.clear();
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables.length = 0;
    }

    private _clearViewDisposables(): void {
        for (const disposable of this._viewDisposables) {
            disposable.dispose();
        }
        this._viewDisposables = [];
    }

    private _guard(label: string, action: () => void | Promise<void>): void {
        if (this._disposed) {
            return;
        }
        try {
            const result = action();
            if (result instanceof Promise) {
                result.catch((err: unknown) => {
                    this._outputChannel?.error(`[VsCodeChangesWebviewProvider] Failed to ${label}: ${String(err)}`);
                });
            }
        } catch (err) {
            this._outputChannel?.error(`[VsCodeChangesWebviewProvider] Failed to ${label}: ${String(err)}`);
        }
    }

    private _updateTitle(): void {
        if (!this._view) {
            return;
        }
        if (this._mode === 'repos') {
            this._view.title = 'Repositories';
            // Dimmed text next to the title: the ordering currently in effect, so the button's
            // state is visible without opening the picker.
            this._view.description = REPO_SORT_SHORT_LABELS[this._repoSortKey];
            return;
        }
        const focused = this._repositoryManager.focusedRepository;
        this._view.title = focused ? `Changes (${path.basename(focused.rootUri.fsPath)})` : 'Changes';
    }

    private _syncSnapshotSubscriptions(): void {
        const alive = new Set<string>();

        // The Changes view only renders the focused repository, so it only subscribes to that
        // repository's snapshots. The Repositories view shows counts for every repository and
        // therefore subscribes to all of them.
        const focusedRoot = this._repositoryManager.focusedRepository?.rootUri.fsPath;
        const changesOnlyRoot = this._mode === 'changes' ? focusedRoot : undefined;

        for (const repo of this._repositoryManager.repositories) {
            const root = repo.rootUri.fsPath;
            if (changesOnlyRoot && root !== changesOnlyRoot) {
                continue;
            }
            alive.add(root);

            try {
                const scm = this._scmProviders.get(root) ?? this._ensureScmProvider?.(repo);
                if (!scm) {
                    this._outputChannel?.info?.(
                        `[ChangesView] No SCM provider for ${root}; will retry on the next sync`,
                    );
                    continue;
                }

                const existing = this._snapshotSubscriptions.get(root);
                if (existing?.model === scm.scmModel) {
                    continue;
                }
                if (existing) {
                    // The provider was rebuilt for this root: the old subscription can never fire.
                    existing.subscription.dispose();
                    this._snapshotSubscriptions.delete(root);
                    this._outputChannel?.info?.(`[ChangesView] Rebinding snapshot subscription for ${root}`);
                }

                const subscription = scm.scmModel.onDidChangeSnapshot(() => {
                    this._guard('post state', () => this._postState());
                });
                this._snapshotSubscriptions.set(root, { model: scm.scmModel, subscription });
            } catch (error: unknown) {
                this._outputChannel?.error(
                    `[ChangesView] Failed to subscribe to ${root}`,
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }

        for (const [root, entry] of this._snapshotSubscriptions) {
            if (!alive.has(root)) {
                entry.subscription.dispose();
                this._snapshotSubscriptions.delete(root);
            }
        }
    }

    private _postInit(): void {
        this._updateTitle();
        this._post({
            type: 'init',
            payload: {
                mode: this._mode,
                contributions: this._packageJson.contributes ?? {},
                openDiffOnClick: this._openDiffOnClick(),
                ...this._statePayload(),
            },
        });
        this._ensureFocusedSnapshot();
        this._ensureRepoSummaries();
    }

    /**
     * The Repositories view needs one snapshot per repository for its counts. Load them only
     * after that view resolves, two at a time: refreshing every repository during activation
     * made the extension host compete for the jj working-copy lock.
     */
    private _ensureRepoSummaries(): void {
        if (this._mode !== 'repos') {
            return;
        }
        const current = new Set(this._repositoryManager.repositories.map((repo) => repo.rootUri.fsPath));
        for (const root of this._summaryRoots) {
            if (!current.has(root)) {
                this._summaryRoots.delete(root);
            }
        }
        const pending = this._repositoryManager.repositories.filter(
            (repo) => !this._summaryRoots.has(repo.rootUri.fsPath),
        );
        if (pending.length === 0) {
            return;
        }
        for (const repo of pending) {
            this._summaryRoots.add(repo.rootUri.fsPath);
        }
        void runWithConcurrency(pending, 2, async (repo) => {
            const root = repo.rootUri.fsPath;
            const scm = this._scmProviders.get(root) ?? this._ensureScmProvider?.(repo);
            if (!scm) {
                this._summaryRoots.delete(root);
                return;
            }
            try {
                await scm.refresh({ forceSnapshot: false, reason: 'repos view summaries' });
            } catch (err) {
                this._summaryRoots.delete(root);
                this._outputChannel?.error(
                    `[ReposView] Summary refresh failed for ${root}`,
                    err instanceof Error ? err : new Error(String(err)),
                );
            }
        });
    }

    /**
     * A freshly (re)installed extension may receive `ready` before any snapshot exists
     * (the provider's initial refresh can fail or still be in flight). Force one refresh
     * so the Changes view is not left blank until the next file event.
     */
    private _ensureFocusedSnapshot(): void {
        if (this._mode !== 'changes') {
            return;
        }
        const focusedRoot = this._repositoryManager.focusedRepository?.rootUri.fsPath;
        if (!focusedRoot) {
            return;
        }
        const scm = this._scmProviders.get(focusedRoot);
        if (!scm || scm.scmModel.snapshot) {
            return;
        }
        void scm.refresh({ forceSnapshot: true, reason: 'changes-view init' }).catch(() => {
            this._outputChannel?.debug?.('[ChangesView] Initial snapshot refresh failed');
        });
    }

    /**
     * Makes sure the focused repository has a snapshot built while it was focused.
     *
     * A one-shot request is not enough: the refresh may fail while jj is busy and no further
     * event will arrive, which left the Changes view (and the repository counts) empty until
     * the user switched repositories. The guard retries a bounded number of times and reports
     * failures to the output channel instead of swallowing them.
     */
    private _requestFocusedSnapshot(): void {
        this._snapshotGuard.run();
    }

    private _postState(): void {
        if (this._disposed) {
            return;
        }
        if (!this._view) {
            if (!this._viewMissingLogged) {
                this._viewMissingLogged = true;
                this._outputChannel?.info?.(
                    `[ChangesView] Skipping ${this._mode} push: the webview has not been resolved`,
                );
            }
            return;
        }
        // Self-heal: a provider registered after the last sync would otherwise never be
        // subscribed, so snapshot events would not reach the webview.
        this._syncSnapshotSubscriptions();
        this._requestFocusedSnapshot();
        this._ensureRepoSummaries();
        this._updateTitle();
        const payload = this._statePayload();
        this._post({ type: 'state', payload });
        this._outputChannel?.info?.(
            `[Changes] push ${this._mode} seq=${payload.seq} version=${payload.snapshot?.version?.slice(0, 8) ?? '-'} wc=${payload.snapshot?.workingCopyCount ?? '-'} ancestors=${payload.snapshot?.ancestors.length ?? '-'} first=${payload.snapshot?.ancestors[0]?.entry.change_id ?? '-'}`,
        );
    }

    private _statePayload(): {
        repos: ChangesWireRepoSummary[];
        focusedRoot: string | undefined;
        snapshot: ChangesWireSnapshot | undefined;
        viewMode: 'list' | 'tree';
        revealChangeIds: string[];
        reposLoading: boolean;
        seq: number;
    } {
        const rows = this._repositoryManager.repositories.map((repo) => {
            const root = repo.rootUri.fsPath;
            const snapshot = this._scmProviders.get(root)?.scmModel.snapshot;
            return {
                root,
                name: path.basename(root),
                // `undefined` means "not known yet"; rendering it as 0 made a cold start look
                // like a clean working copy.
                changeCount: snapshot ? snapshot.workingCopyCount : undefined,
                conflictCount: snapshot ? snapshot.conflictedPaths.length : 0,
                lastCommitAt: snapshot?.currentEntry?.committer.timestamp,
            };
        });
        const repos = sortRepos(rows, this._repoSortKey);

        const focusedRoot = this._repositoryManager.focusedRepository?.rootUri.fsPath;
        const focusedSnapshot = focusedRoot ? this._scmProviders.get(focusedRoot)?.scmModel.snapshot : undefined;

        // One-shot: the webview expands these groups once and the next push must not repeat.
        const revealChangeIds = this._revealChangeIds;
        this._revealChangeIds = [];

        return {
            repos,
            focusedRoot,
            snapshot: this._mode === 'changes' && focusedSnapshot ? toWireSnapshot(focusedSnapshot) : undefined,
            viewMode: this._viewMode,
            revealChangeIds,
            reposLoading: this._isReposLoading(),
            // Lets the webview drop a state that arrives after a newer one. Provider-scoped,
            // so recreating an ScmModel cannot restart the counter and freeze the view.
            seq: ++this._pushSeq,
        };
    }

    private _post(message: unknown): void {
        if (this._disposed || !this._view) {
            return;
        }
        void this._view.webview.postMessage(message);
    }

    private async _handleMessage(message: HostMessage): Promise<void> {
        switch (message?.type) {
            case 'ready':
                // The webview can be ready before the first repository event; bind here too so a
                // missed sync cannot leave the view without snapshot events.
                this._syncSnapshotSubscriptions();
                this._postInit();
                return;
            case 'focusRepository': {
                const repo = this._findRepository(message.payload.root);
                if (repo) {
                    this._repositoryManager.setFocusedRepository(repo);
                }
                return;
            }
            case 'refresh': {
                if (this._mode === 'changes') {
                    await this._reloadChangesView();
                    return;
                }
                const root = message.payload?.root ?? this._repositoryManager.focusedRepository?.rootUri.fsPath;
                const targets = root
                    ? [this._scmProviders.get(root)].filter((scm): scm is VsCodeScmProvider => Boolean(scm))
                    : Array.from(this._scmProviders.values());
                await Promise.all(targets.map((scm) => scm.refresh({ forceSnapshot: true, reason: 'changes-view' })));
                return;
            }
            case 'draft': {
                // Keep the SCM input box in sync so the view title bar's Commit action
                // (jj-view.commit) picks up the text typed in the changes webview.
                const scm = this._scmProviders.get(message.payload.root);
                if (scm) {
                    scm.setDraft(message.payload.description);
                }
                return;
            }
            case 'open': {
                const state = this._buildResourceState(message.payload.root, message.payload.state);
                if (!state) {
                    return;
                }
                const command = state.command;
                if (command) {
                    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
                } else {
                    await vscode.commands.executeCommand('jj-view.openChanges', state);
                }
                return;
            }
            case 'action': {
                const { root, command, state, groupId, paths, folder } = message.payload;
                const args = this._buildCommandArguments(root, state, groupId, paths, folder);
                if (args === undefined) {
                    return;
                }
                await vscode.commands.executeCommand(command, ...args);
                return;
            }
            case 'commit': {
                const { root, description } = message.payload;
                this._focus(root);
                const scm = this._scmProviders.get(root);
                if (scm) {
                    // Mirror the webview input into the draft so `jj-view.commit` (which reads
                    // the draft) commits the right description.
                    scm.setDraft(description);
                }
                const result = await vscode.commands.executeCommand<CommitResult>('jj-view.commit');
                if (result?.committed) {
                    // The text is in the commit now: drop it so the next commit cannot reuse it.
                    this._scmProviders.get(root)?.clearDraft();
                }
                // Push the post-commit state explicitly: the commit already refreshed the
                // snapshot, so the Changes view must show it even if no event arrives.
                this._postState();
                return;
            }
            case 'setDescription': {
                this._focus(message.payload.root);
                await vscode.commands.executeCommand('jj-view.setDescription', message.payload.description);
                // The text now lives on the working-copy commit, so it is no longer a draft.
                this._scmProviders.get(message.payload.root)?.clearDraft();
                return;
            }
            default:
                return;
        }
    }

    private _focus(root: string): void {
        const repo = this._findRepository(root);
        if (repo && this._repositoryManager.focusedRepository?.rootUri.fsPath !== root) {
            this._repositoryManager.setFocusedRepository(repo);
        }
    }

    private _findRepository(root: string): JjRepository | undefined {
        return this._repositoryManager.repositories.find((repo) => repo.rootUri.fsPath === root);
    }

    private _openDiffOnClick(): boolean {
        return vscode.workspace.getConfiguration('jj-view').get<boolean>('openDiffOnClick', true);
    }

    private _buildCommandArguments(
        root: string,
        state: ChangesWireResourceState | undefined,
        groupId: string | undefined,
        paths?: string[],
        folder?: string,
    ): unknown[] | undefined {
        if (paths && paths.length > 0) {
            // Carries `root` so the command resolves the focused repository, not the editor.
            return [{ root, paths, ...(folder ? { folder } : {}) }];
        }
        if (groupId) {
            const group = this._buildResourceGroup(root, groupId);
            return group ? [group] : undefined;
        }
        if (state) {
            const resourceState = this._buildResourceState(root, state);
            return resourceState ? [resourceState] : undefined;
        }
        return [];
    }

    private _buildResourceState(root: string, wire: ChangesWireResourceState): JjResourceState | undefined {
        const scm = this._scmProviders.get(root);
        if (!scm) {
            return undefined;
        }
        const snapshot = scm.scmModel.snapshot;
        const contextValue = wire.contextValue ?? '';

        return createJjResourceState(
            {
                path: wire.path,
                status: wire.status ?? 'modified',
                conflicted: wire.conflicted,
            },
            wire.revision,
            root,
            {
                openDiffOnClick: this._openDiffOnClick(),
                hasChild: snapshot?.hasChild ?? false,
                squashable: contextValue.includes(ScmContextValue.ResourceAllowSquashIntoParent),
                multipleAncestors: contextValue.includes(ScmContextValue.ResourceAllowSquashIntoAncestor),
                inConflictGroup: wire.conflicted === true,
                workingCopyChangeId: snapshot?.currentEntry?.change_id,
            },
        );
    }

    private _buildResourceGroup(
        root: string,
        groupId: string,
    ): { id: string; ancestor?: unknown; rootUri: Uri; resourceStates: JjResourceState[] } | undefined {
        const scm = this._scmProviders.get(root);
        if (!scm) {
            return undefined;
        }

        const repo = scm.repo;
        const snapshot = scm.scmModel.snapshot;
        const openDiffOnClick = this._openDiffOnClick();
        const workingCopyChangeId = snapshot?.currentEntry?.change_id;
        const conflicted = new Set(snapshot?.conflictedPaths ?? []);

        if (groupId === 'conflicts') {
            return {
                id: ScmContextValue.ConflictGroup,
                rootUri: repo.rootUri,
                resourceStates: (snapshot?.conflictedPaths ?? []).map((conflictedPath) =>
                    createJjResourceState({ path: conflictedPath, status: 'modified', conflicted: true }, '@', root, {
                        openDiffOnClick,
                        inConflictGroup: true,
                        workingCopyChangeId,
                    }),
                ),
            };
        }

        if (groupId === 'working-copy') {
            return {
                id: ScmContextValue.WorkingCopyGroup,
                rootUri: repo.rootUri,
                resourceStates: (snapshot?.workingCopyChanges ?? [])
                    .filter((change) => !conflicted.has(change.path))
                    .map((change) =>
                        createJjResourceState(change, '@', root, {
                            squashable: snapshot?.parentMutable,
                            multipleAncestors: (snapshot?.ancestors.length ?? 0) > 1,
                            openDiffOnClick,
                            hasChild: snapshot?.hasChild,
                            workingCopyChangeId,
                        }),
                    ),
            };
        }

        if (groupId.startsWith('ancestor-')) {
            const index = Number.parseInt(groupId.slice('ancestor-'.length), 10);
            const ancestor = snapshot?.ancestors[index];
            if (!ancestor) {
                return undefined;
            }
            const remainingAncestors = (snapshot?.ancestors.length ?? 0) - 1 - index;
            return {
                id: groupId,
                ancestor,
                rootUri: repo.rootUri,
                resourceStates: ancestor.changes.map((change) =>
                    createJjResourceState(change, ancestor.entry.change_id, root, {
                        squashable: ancestor.canSquash,
                        multipleAncestors: remainingAncestors > 0,
                        openDiffOnClick,
                        workingCopyChangeId,
                    }),
                ),
            };
        }

        return undefined;
    }
}

function toWireSnapshot(snapshot: ScmSnapshot): ChangesWireSnapshot {
    return {
        currentEntry: snapshot.currentEntry,
        workingCopyChanges: snapshot.workingCopyChanges,
        workingCopyLabel: snapshot.workingCopyLabel,
        workingCopyContextValue: snapshot.workingCopyContextValue,
        conflictedPaths: snapshot.conflictedPaths,
        ancestors: snapshot.ancestors,
        parentMutable: snapshot.parentMutable,
        hasChild: snapshot.hasChild,
        description: snapshot.description,
        workingCopyCount: snapshot.workingCopyCount,
        revision: snapshot.revision,
    };
}
