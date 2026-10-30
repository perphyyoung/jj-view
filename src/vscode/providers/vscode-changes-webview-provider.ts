/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { ScmContextValue } from '../../core/jj-context-keys';
import type { JjRepository } from '../../core/jj-repository';
import type { JjRepositoryManager } from '../../core/jj-repository-manager';
import type { JjStatusEntry } from '../../core/jj-types';
import type { ScmSnapshot } from '../../core/scm-model';
import { createJjResourceState, type JjResourceState } from '../../core/scm-resource-state';
import type { Uri } from '../../core/uri-utils';
import type { LoggerChannel } from '../../utils/output-channel';
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
    changeCount: number;
    conflictCount: number;
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
    private readonly _disposables: vscode.Disposable[] = [];
    private _viewDisposables: vscode.Disposable[] = [];
    private readonly _snapshotSubscriptions = new Map<string, { dispose(): void }>();

    private static readonly VIEW_MODE_KEY = 'jj-view.changesViewMode';

    constructor(
        private readonly _extensionUri: Uri,
        private readonly _repositoryManager: JjRepositoryManager,
        private readonly _scmProviders: Map<string, VsCodeScmProvider>,
        private readonly _packageJson: { contributes?: unknown },
        private readonly _context: vscode.ExtensionContext,
        private readonly _mode: ChangesViewMode,
        private readonly _outputChannel?: LoggerChannel,
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

        if (this._mode === 'changes') {
            void vscode.commands.executeCommand('setContext', 'jj.changesViewAsTree', this._viewMode === 'tree');
            this._disposables.push(
                vscode.commands.registerCommand('jj-view.changesAsTree', () => this._setViewMode('tree')),
                vscode.commands.registerCommand('jj-view.changesAsList', () => this._setViewMode('list')),
            );
        }
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
        this._updateTitle();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri as unknown as vscode.Uri],
        };
        webviewView.webview.html = getWebviewHtml({
            webview: webviewView.webview,
            extensionUri: this._extensionUri,
            scriptPath: ['dist', 'webview', 'changes.js'],
            title: this._mode === 'repos' ? 'JJ Repositories' : 'JJ Changes',
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
        this._clearViewDisposables();
        for (const subscription of this._snapshotSubscriptions.values()) {
            subscription.dispose();
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
            if (this._snapshotSubscriptions.has(root)) {
                continue;
            }

            const scm = this._scmProviders.get(root);
            if (!scm) {
                continue;
            }

            const subscription = scm.scmModel.onDidChangeSnapshot(() => {
                this._guard('post state', () => this._postState());
            });
            this._snapshotSubscriptions.set(root, subscription);
        }

        for (const [root, subscription] of this._snapshotSubscriptions) {
            if (!alive.has(root)) {
                subscription.dispose();
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
    }

    private _postState(): void {
        if (this._disposed || !this._view) {
            return;
        }
        this._updateTitle();
        this._post({ type: 'state', payload: this._statePayload() });
    }

    private _statePayload(): {
        repos: ChangesWireRepoSummary[];
        focusedRoot: string | undefined;
        snapshot: ChangesWireSnapshot | undefined;
        viewMode: 'list' | 'tree';
    } {
        const repos = this._repositoryManager.repositories.map((repo) => {
            const root = repo.rootUri.fsPath;
            const snapshot = this._scmProviders.get(root)?.scmModel.snapshot;
            return {
                root,
                name: path.basename(root),
                changeCount: snapshot?.workingCopyCount ?? 0,
                conflictCount: snapshot?.conflictedPaths.length ?? 0,
            };
        });

        const focusedRoot = this._repositoryManager.focusedRepository?.rootUri.fsPath;
        const focusedSnapshot = focusedRoot ? this._scmProviders.get(focusedRoot)?.scmModel.snapshot : undefined;

        return {
            repos,
            focusedRoot,
            snapshot: this._mode === 'changes' && focusedSnapshot ? toWireSnapshot(focusedSnapshot) : undefined,
            viewMode: this._viewMode,
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
                const root = message.payload?.root ?? this._repositoryManager.focusedRepository?.rootUri.fsPath;
                const targets = root
                    ? [this._scmProviders.get(root)].filter((scm): scm is VsCodeScmProvider => Boolean(scm))
                    : Array.from(this._scmProviders.values());
                await Promise.all(targets.map((scm) => scm.refresh({ reason: 'changes-view' })));
                return;
            }
            case 'draft': {
                // Keep the SCM input box in sync so the view title bar's Commit action
                // (jj-view.commit) picks up the text typed in the changes webview.
                const scm = this._scmProviders.get(message.payload.root);
                if (scm) {
                    scm.setInputBoxValue(message.payload.description);
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
                const { root, command, state, groupId } = message.payload;
                const args = this._buildCommandArguments(root, state, groupId);
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
                    // Mirror the webview input into the SCM input box so `jj-view.commit`
                    // (which reads SourceControl.inputBox) commits the right description.
                    scm.setInputBoxValue(description);
                }
                await vscode.commands.executeCommand('jj-view.setDescription', description);
                await vscode.commands.executeCommand('jj-view.commit');
                return;
            }
            case 'setDescription': {
                this._focus(message.payload.root);
                await vscode.commands.executeCommand('jj-view.setDescription', message.payload.description);
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
    ): unknown[] | undefined {
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
    };
}
