/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getSquashStorageDir, isSquashInProgress } from '../core/commands/squash-revision';
import { JjContextKey } from '../core/jj-context-keys';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjProcessTracker } from '../core/jj-process-tracker';
import type { JjRepository } from '../core/jj-repository';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { JjViewFsService } from '../core/jj-view-fs-service';
import { resolveJjBinary } from '../utils/binary-utils';
import { toError } from '../utils/error-utils';
import { type LoggerChannel, OutputChannel } from '../utils/output-channel';
import { checkGitColocation } from './git-colocation';
import { VsCodeChangesWebviewProvider } from './providers/vscode-changes-webview-provider';
import { VsCodeCommitDetailsEditorProvider } from './providers/vscode-commit-details-editor-provider';
import { VsCodeEditFsProvider } from './providers/vscode-edit-fs-provider';
import { VsCodeLineBlameProvider } from './providers/vscode-line-blame-provider';
import { VsCodeLogWebviewProvider } from './providers/vscode-log-webview-provider';
import { VsCodeProcessMonitorProvider } from './providers/vscode-process-monitor-provider';
import { VsCodeScmProvider } from './providers/vscode-scm-provider';
import { VsCodeViewFsProvider } from './providers/vscode-view-fs-provider';
import { registerVSCodeCommands } from './register-commands';
import { registerProcessMonitorCommands } from './register-process-monitor-commands';
import { VsCodeHostEnvironment, VsCodeHostNavigation } from './vscode-host-environment';
import { prewarmWebviewCssCache } from './vscode-webview-html';

export interface Api {
    repositoryManager: JjRepositoryManager;
    scmProviders: Map<string, VsCodeScmProvider>;
    resetState(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
    const folders = vscode.workspace.workspaceFolders || [];
    const workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : '';
    const realOutputChannel = vscode.window.createOutputChannel('JJ View Local', { log: true });
    const outputChannel = new OutputChannel(realOutputChannel);
    context.subscriptions.push(realOutputChannel);

    const hostEnvironment = new VsCodeHostEnvironment({ context, logger: outputChannel });
    context.subscriptions.push(hostEnvironment);

    prewarmWebviewCssCache(context.extensionUri);

    // Get preferred binary path configuration
    const preferredPath = hostEnvironment.config.get<string>('binaryPath');
    let resolvedBinaryPath: string | undefined;
    try {
        resolvedBinaryPath = await resolveJjBinary(preferredPath, workspaceRoot);
    } catch {
        // Ignore initial error, updateBinaryPath() below will show notification
    }

    // Configure configurations update listener
    const updateBinaryPath = async () => {
        const preferredPath = hostEnvironment.config.get<string>('binaryPath');

        let resolvedPath: string | undefined;
        let errorMessage: string | undefined;

        try {
            resolvedPath = await resolveJjBinary(preferredPath, workspaceRoot);
            if (!resolvedPath) {
                errorMessage = `Could not find 'jj' binary. Please ensure 'jj' is installed and in your PATH, or configure its path manually.`;
            }
        } catch (e: unknown) {
            errorMessage = `Invalid 'jj' binary configuration: ${toError(e).message}`;
        }

        if (resolvedPath) {
            repositoryManager.setBinaryPath(resolvedPath);
            outputChannel.info(`[Extension] Using jj binary at: ${resolvedPath}`);
        } else if (errorMessage) {
            showBinaryError(errorMessage);
        }
    };

    const showBinaryError = (message: string) => {
        const CONFIGURE = 'Configure Path';
        hostEnvironment.ui.showErrorMessage(message, CONFIGURE).then((selection) => {
            if (selection === CONFIGURE) {
                hostEnvironment.nav.openSettings('jj-view.binaryPath');
            }
        });
    };

    const setOpenDiffOnClickContext = () => {
        const value = hostEnvironment.config.get<boolean>('openDiffOnClick', true);
        hostEnvironment.commands.setContextKey(JjContextKey.OpenDiffOnClick, value);
    };
    setOpenDiffOnClickContext();

    const processTracker = new JjProcessTracker();
    context.subscriptions.push(processTracker);
    const processStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    processStatusBarItem.command = 'jj-view.showProcessMonitor';
    context.subscriptions.push(processStatusBarItem);

    const updateProcessStatusBar = () => {
        const showProcessMonitor = hostEnvironment.config.get<boolean>('showProcessMonitorPanel', false);
        const metrics = processTracker.getMetrics();
        if (showProcessMonitor && metrics.activeCount > 0) {
            processStatusBarItem.text = `$(sync~spin) JJ: ${metrics.activeCount} running`;
            processStatusBarItem.tooltip = `${metrics.activeCount} JJ process(es) running. Click to open Process Monitor.`;
            processStatusBarItem.show();
        } else {
            processStatusBarItem.hide();
        }
    };

    context.subscriptions.push(processTracker.onDidChangeProcesses(updateProcessStatusBar));

    registerProcessMonitorCommands(context, processTracker);

    const repositoryManager = new JjRepositoryManager(
        outputChannel,
        hostEnvironment,
        resolvedBinaryPath,
        processTracker,
    );
    context.subscriptions.push(repositoryManager);

    if (hostEnvironment.config.onDidChangeConfiguration) {
        context.subscriptions.push(
            hostEnvironment.config.onDidChangeConfiguration(async (e) => {
                if (e.affectsConfiguration('jj-view.showProcessMonitorPanel')) {
                    updateProcessStatusBar();
                }
                if (e.affectsConfiguration('jj-view.binaryPath')) {
                    await updateBinaryPath();
                    await repositoryManager.scanForRepositories();
                }
                if (e.affectsConfiguration('jj-view.openDiffOnClick')) {
                    setOpenDiffOnClickContext();
                    await Promise.all(
                        Array.from(scmProviders.values()).map((scm) =>
                            scm.repo.refresh({ reason: 'openDiffOnClick config change' }),
                        ),
                    );
                }
                if (
                    e.affectsConfiguration('jj-view.autoRepositoryDetection') ||
                    e.affectsConfiguration('jj-view.scanRepositories') ||
                    e.affectsConfiguration('jj-view.ignoredRepositories')
                ) {
                    await repositoryManager.scanForRepositories();
                }
                if (
                    e.affectsConfiguration('jj-view.commit') ||
                    e.affectsConfiguration('jj-view.minChangeIdLength') ||
                    e.affectsConfiguration('jj-view.logTheme')
                ) {
                    await commitDetailsProvider.refresh();
                }
            }),
        );
    }

    const viewFsService = new JjViewFsService(repositoryManager);
    const viewFileSystemProvider = new VsCodeViewFsProvider(viewFsService);

    const editFsService = new JjEditFsService(repositoryManager);
    const editFileSystemProvider = new VsCodeEditFsProvider(editFsService);

    // Register FileSystemProvider for read-only access to old file versions (for diffs)
    context.subscriptions.push(
        viewFileSystemProvider,
        vscode.workspace.registerFileSystemProvider('jj-view', viewFileSystemProvider, { isReadonly: true }),
    );

    // Register FileSystemProvider for editable access to mutable revision files
    context.subscriptions.push(
        editFileSystemProvider,
        vscode.workspace.registerFileSystemProvider('jj-edit', editFileSystemProvider),
    );

    // Finalize squash when the SQUASH_MSG tab is closed
    context.subscriptions.push(
        vscode.window.tabGroups.onDidChangeTabs(async (e) => {
            for (const tab of e.closed) {
                if (tab.input instanceof vscode.TabInputText && path.basename(tab.input.uri.fsPath) === 'SQUASH_MSG') {
                    const focused = repositoryManager.focusedRepository;
                    if (!focused) {
                        return;
                    }
                    const storageDir = getSquashStorageDir(focused.jj.workspaceRoot);
                    const metaPath = path.join(storageDir, 'SQUASH_META.json');

                    try {
                        await fs.access(metaPath);
                        if (isSquashInProgress(focused.jj.workspaceRoot)) {
                            return;
                        }

                        await vscode.commands.executeCommand('jj-view.completeSquashRevision');
                    } catch {
                        // No pending squash, ignore
                    }
                }
            }
        }),
    );

    const scmProviders = new Map<string, VsCodeScmProvider>();
    const activeScmSubscriptions = new Map<string, vscode.Disposable>();

    // Wire up edit provider refresh
    editFileSystemProvider.onDidWrite = (repo) => {
        const scm = scmProviders.get(repo.rootUri.fsPath);
        scm?.refresh();
    };

    const commitDetailsProvider = new VsCodeCommitDetailsEditorProvider(
        context.extensionUri,
        repositoryManager,
        context,
    );
    context.subscriptions.push(
        commitDetailsProvider,
        vscode.window.registerCustomEditorProvider(VsCodeCommitDetailsEditorProvider.viewType, commitDetailsProvider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
    );

    // Get an initial repo for webview log startup
    const logWebviewProvider = new VsCodeLogWebviewProvider(
        context.extensionUri,
        undefined,
        (ids) => {
            const focused = repositoryManager.focusedRepository;
            if (focused) {
                const scm = scmProviders.get(focused.rootUri.fsPath);
                scm?.handleSelectionChange(ids);
            }
        },
        context,
        outputChannel,
    );
    context.subscriptions.push(
        logWebviewProvider,
        vscode.window.registerWebviewViewProvider(VsCodeLogWebviewProvider.viewType, logWebviewProvider),
    );

    const reposWebviewProvider = new VsCodeChangesWebviewProvider(
        context.extensionUri,
        repositoryManager,
        scmProviders,
        context.extension.packageJSON,
        context,
        'repos',
        outputChannel,
    );
    const changesWebviewProvider = new VsCodeChangesWebviewProvider(
        context.extensionUri,
        repositoryManager,
        scmProviders,
        context.extension.packageJSON,
        context,
        'changes',
        outputChannel,
    );
    context.subscriptions.push(
        reposWebviewProvider,
        changesWebviewProvider,
        vscode.window.registerWebviewViewProvider('jj-view.reposView', reposWebviewProvider),
        vscode.window.registerWebviewViewProvider('jj-view.changesView', changesWebviewProvider),
    );

    if (hostEnvironment.nav instanceof VsCodeHostNavigation) {
        hostEnvironment.nav.setHighlightDelegate((repoRoot, changeId) => {
            if (logWebviewProvider.repository?.rootUri.toString() === repoRoot.toString()) {
                logWebviewProvider.controller.setHighlightedCommit(changeId);
            }
        });
    }

    const processMonitorProvider = new VsCodeProcessMonitorProvider(context.extensionUri, processTracker, context);
    context.subscriptions.push(
        processMonitorProvider,
        vscode.window.registerWebviewViewProvider(VsCodeProcessMonitorProvider.viewType, processMonitorProvider),
    );

    context.subscriptions.push(
        commitDetailsProvider.onDidClosePanel((changeId) => {
            logWebviewProvider.controller.handlePanelClosed(changeId);
        }),
    );

    /**
     * Creates (or returns) the SCM provider for a repository. Kept separate from
     * `onDidOpenRepository` so a forced refresh can rebuild providers that failed to
     * initialize when the extension was (re)installed.
     */
    const ensureScmProvider = (repo: JjRepository): VsCodeScmProvider => {
        const existing = scmProviders.get(repo.rootUri.fsPath);
        if (existing) {
            return existing;
        }

        const repoPrefix = path.basename(repo.rootUri.fsPath);
        const repoOutputChannel = new OutputChannel(realOutputChannel, repoPrefix);
        const scmProvider = new VsCodeScmProvider(
            context,
            repo,
            repoOutputChannel,
            repositoryManager,
            viewFileSystemProvider,
            editFileSystemProvider,
            () => repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath,
            undefined,
        );

        const decorationProvider = vscode.window.registerFileDecorationProvider(scmProvider.decorationProvider);
        const repoStatusSub = repo.onDidStatusChange((event) => {
            if (repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath) {
                // Refresh webview and commit details panel in parallel
                Promise.all([
                    logWebviewProvider.controller.refresh(event.reason),
                    commitDetailsProvider.refresh(),
                ]).catch((err) => {
                    outputChannel.error('[Extension] Failed to refresh views on status change', toError(err));
                });
            }
        });

        const composite = vscode.Disposable.from(scmProvider, decorationProvider, repoStatusSub);
        scmProviders.set(repo.rootUri.fsPath, scmProvider);
        activeScmSubscriptions.set(repo.rootUri.fsPath, composite);
        outputChannel.info(`[Extension] Created SCM provider for ${repo.rootUri.fsPath}`);

        if (
            !logWebviewProvider.repository ||
            repositoryManager.focusedRepository?.rootUri.fsPath === repo.rootUri.fsPath
        ) {
            logWebviewProvider.updateRepository(repo).catch((err) => {
                outputChannel.error('[Extension] Failed to update webview repository', toError(err));
            });
        }

        // Fire and forget: check if we should warn about git colocation
        checkGitColocation(repo.jj).catch((e) => {
            outputChannel.error(`[Extension] Colocation check failed for ${repoPrefix}`, toError(e));
        });

        return scmProvider;
    };

    /**
     * Force refresh every repository: drop the cached repository list, rescan the
     * workspace folders and rebuild + refresh each SCM snapshot. Used by the
     * Repositories view title button, where a single-repository refresh is not enough
     * (e.g. after reinstalling the extension, when some providers failed to initialize).
     */
    const forceRefreshAllRepositories = async (): Promise<void> => {
        const start = performance.now();
        const previousFocusedRoot = repositoryManager.focusedRepository?.rootUri.fsPath;
        outputChannel.info('[Extension] Force refresh all repositories: clearing and rescanning...');
        await repositoryManager.clear();
        await repositoryManager.scanForRepositories();

        const repos = repositoryManager.repositories;
        await Promise.all(
            repos.map(async (repo) => {
                try {
                    await repo.jj.clearCache();
                    const scm = ensureScmProvider(repo);
                    await scm.refresh({ forceSnapshot: true, reason: 'force refresh all' });
                    outputChannel.info(`[Extension] Refreshed repository ${repo.rootUri.fsPath}`);
                } catch (e: unknown) {
                    outputChannel.error(`[Extension] Failed to refresh repository ${repo.rootUri.fsPath}`, toError(e));
                }
            }),
        );

        // `clear()` drops the focused repository; restore it so the views keep showing
        // the same project after a full rescan.
        if (previousFocusedRoot) {
            const restored = repos.find((repo) => repo.rootUri.fsPath === previousFocusedRoot);
            if (restored) {
                repositoryManager.setFocusedRepository(restored);
            }
        }

        const elapsed = (performance.now() - start).toFixed(0);
        outputChannel.info(`[Extension] Force refresh all done in ${elapsed}ms (${repos.length} repositories)`);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('jj-view.refreshAll', forceRefreshAllRepositories),
        repositoryManager.onDidOpenRepository((repo) => {
            ensureScmProvider(repo);
        }),
        // Belt-and-braces: providers can be missed when repositories are registered while
        // activation is still wiring things up (cached restore / workspace scan). Re-ensuring
        // on every repository-list change makes the missing-provider state self-healing.
        repositoryManager.onDidChangeRepositories(() => {
            for (const repo of repositoryManager.repositories) {
                ensureScmProvider(repo);
            }
        }),
        repositoryManager.onDidCloseRepository(async (repo) => {
            const sub = activeScmSubscriptions.get(repo.rootUri.fsPath);
            if (sub) {
                sub.dispose();
                activeScmSubscriptions.delete(repo.rootUri.fsPath);
            }
            scmProviders.delete(repo.rootUri.fsPath);
        }),
    );

    // GitLens-style current-line blame rendered at the end of the active line.
    context.subscriptions.push(new VsCodeLineBlameProvider(repositoryManager, outputChannel));

    context.subscriptions.push(
        repositoryManager.onDidChangeFocusedRepository((repo) => {
            if (repo) {
                ensureScmProvider(repo);
                logWebviewProvider.updateRepository(repo).catch((err) => {
                    outputChannel.error('[Extension] Failed to update webview repository', toError(err));
                });
                commitDetailsProvider.refresh().catch((err) => {
                    outputChannel.error('[Extension] Failed to refresh commit details for focused repo', toError(err));
                });
                const scm = scmProviders.get(repo.rootUri.fsPath);
                if (scm) {
                    hostEnvironment.commands.setContextKey(JjContextKey.ParentMutable, scm.parentMutable);
                    hostEnvironment.commands.setContextKey(JjContextKey.HasChild, scm.hasChild);
                }
            } else {
                hostEnvironment.commands.setContextKey(JjContextKey.ParentMutable, false);
                hostEnvironment.commands.setContextKey(JjContextKey.HasChild, false);
            }
        }),
        {
            dispose: () => {
                for (const sub of activeScmSubscriptions.values()) {
                    sub.dispose();
                }
                activeScmSubscriptions.clear();
                scmProviders.clear();
            },
        },
    );

    registerVSCodeCommands({
        context,
        repositoryManager,
        scmProviders,
        outputChannel,
        logWebviewProvider,
        hostEnvironment,
        ensureScmProvider,
    });

    context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution((event) => {
            const focused = repositoryManager.focusedRepository;
            if (focused) {
                const scm = scmProviders.get(focused.rootUri.fsPath);
                if (scm) {
                    handleTerminalExecution(event.execution.commandLine.value, outputChannel, scm);
                }
            }
        }),
    );

    // Load cached repositories immediately
    await repositoryManager.restoreCachedRepositories();

    // Restored repositories rely on `onDidOpenRepository`; ensure the providers exist even
    // if that event was emitted before the listener above was registered.
    for (const repo of repositoryManager.repositories) {
        ensureScmProvider(repo);
    }

    // Trigger initial scan (non-blocking)
    if (!resolvedBinaryPath) {
        updateBinaryPath()
            .then(() => repositoryManager.scanForRepositories())
            .catch((err: unknown) => {
                outputChannel.error('[Extension] Initial repository scan failed', toError(err));
            });
    } else {
        repositoryManager.scanForRepositories().catch((err: unknown) => {
            outputChannel.error('[Extension] Initial repository scan failed', toError(err));
        });
    }

    return {
        repositoryManager,
        scmProviders,
        resetState: async () => {
            for (const key of context.globalState?.keys?.() ?? []) {
                await context.globalState.update(key, undefined);
            }
            for (const key of context.workspaceState?.keys?.() ?? []) {
                await context.workspaceState.update(key, undefined);
            }
            await repositoryManager.clear();
        },
    };
}

/** Checks if a terminal command is a jj upload or push and triggers staggered code forge refreshes. */
export function handleTerminalExecution(
    commandLine: string,
    outputChannel: LoggerChannel,
    scmProvider: VsCodeScmProvider,
): boolean {
    const cmd = commandLine.trim();
    if (cmd.startsWith('jj') && (cmd.includes('upload') || cmd.includes('git push'))) {
        outputChannel.info(`[Extension] Detected terminal upload/push: "${cmd}"`);
        scmProvider.refresh({ reason: 'terminal upload/push' });
        return true;
    }
    return false;
}

export function deactivate() {}
