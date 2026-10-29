<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import ContextMenu from '../../../../web/src/menu/ContextMenu.svelte';
import { ContextKeyService } from '../../../../web/src/menu/context-key-service';
import { extractVsCodeContext } from '../../../../web/src/menu/context-menu-utils';
import { MenuRegistry } from '../../../../web/src/menu/menu-registry';
import type { PackageJsonContributes, ResolvedMenuItemGroup } from '../../../../web/src/menu/menu-types';
import ScmPane from '../../../../web/src/scm/ScmPane.svelte';
import type { JjStatusEntry } from '../../jj-types';
import type { ScmSnapshot } from '../../scm-model';
import type { JjResourceState } from '../../scm-resource-state';
import { useBridge, useMessageListener } from '../transport/bridge.svelte';

type WireSnapshot = Omit<ScmSnapshot, 'workingCopyStatuses'>;
type ViewMode = 'repos' | 'changes';

interface RepoSummary {
    root: string;
    name: string;
    changeCount: number;
    conflictCount: number;
}

interface WireResourceState {
    path: string;
    revision: string;
    status?: JjStatusEntry['status'];
    conflicted?: boolean;
    contextValue?: string;
}

interface StatePayload {
    repos: RepoSummary[];
    focusedRoot?: string;
    snapshot?: WireSnapshot;
    viewMode?: 'list' | 'tree';
}

interface InitPayload extends StatePayload {
    mode?: ViewMode;
    openDiffOnClick?: boolean;
    contributions?: PackageJsonContributes;
}

interface ContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    groups: readonly ResolvedMenuItemGroup[];
    payload?: unknown;
}

const bridge = useBridge();
const menuRegistry = new MenuRegistry({});
const rootContext = new ContextKeyService();

let mode = $state<ViewMode>('changes');
let repos = $state<RepoSummary[]>([]);
let focusedRoot = $state<string | undefined>(undefined);
let snapshot = $state<ScmSnapshot | undefined>(undefined);
let viewMode = $state<'list' | 'tree'>('list');
let openDiffOnClick = $state(true);
let contributionsLoaded = false;

let contextMenu = $state<ContextMenuState>({ visible: false, x: 0, y: 0, groups: [] });

function hydrate(wire: WireSnapshot | undefined): ScmSnapshot | undefined {
    if (!wire) {
        return undefined;
    }
    return { ...(wire as unknown as ScmSnapshot), workingCopyStatuses: new Map() };
}

function applyState(payload: StatePayload): void {
    repos = payload.repos ?? [];
    focusedRoot = payload.focusedRoot;
    snapshot = hydrate(payload.snapshot);
    viewMode = payload.viewMode ?? viewMode;
}

useMessageListener<Record<string, unknown>>((raw) => {
    const type = raw?.type;
    const payload = raw?.payload as Record<string, unknown> | undefined;
    if (!payload) {
        return;
    }

    if (type === 'init') {
        const init = payload as unknown as InitPayload;
        mode = init.mode ?? 'changes';
        openDiffOnClick = init.openDiffOnClick ?? true;
        if (!contributionsLoaded && init.contributions) {
            menuRegistry.registerContributes(init.contributions);
            contributionsLoaded = true;
        }
        applyState(init);
        return;
    }

    if (type === 'state') {
        applyState(payload as unknown as StatePayload);
    }
});

function post(message: unknown): void {
    void bridge.postMessage(message);
}

function focusRepository(root: string): void {
    if (root === focusedRoot) {
        return;
    }
    post({ type: 'focusRepository', payload: { root } });
}

function toWireState(state: JjResourceState): WireResourceState {
    const contextValue = state.contextValue ?? '';
    return {
        path: state.relativePath ?? '',
        revision: state.revision,
        status: state.status,
        contextValue,
        conflicted: contextValue.includes('allowOpenMergeEditor'),
    };
}

function isResourceStateLike(value: unknown): value is JjResourceState {
    return (
        typeof value === 'object' &&
        value !== null &&
        'revision' in value &&
        ('relativePath' in value || 'resourceUri' in value)
    );
}

function openResource(state: JjResourceState): void {
    if (!focusedRoot) {
        return;
    }
    post({ type: 'open', payload: { root: focusedRoot, state: toWireState(state) } });
}

function dispatchAction(command: string, payload?: unknown): void {
    if (!focusedRoot) {
        return;
    }

    let target = payload;
    if (target && typeof target === 'object' && 'resourceState' in target) {
        target = (target as { resourceState: unknown }).resourceState;
    }

    if (isResourceStateLike(target)) {
        post({ type: 'action', payload: { root: focusedRoot, command, state: toWireState(target) } });
        return;
    }

    const groupId =
        typeof target === 'object' && target !== null
            ? ((target as { scmResourceGroupId?: string }).scmResourceGroupId ??
              (target as { groupId?: string }).groupId)
            : undefined;

    post({ type: 'action', payload: { root: focusedRoot, command, groupId } });
}

function handleWindowContextMenu(event: MouseEvent): void {
    const target = event.target as Element | null;
    const context = extractVsCodeContext(target);
    if (!context) {
        if (contextMenu.visible) {
            contextMenu = { ...contextMenu, visible: false };
        }
        return;
    }

    if (context.preventDefaultContextMenuItems) {
        event.preventDefault();
    }

    const menuId = typeof context.menuId === 'string' ? context.menuId : 'webview/context';
    const scopedContext = rootContext.createScoped(context);
    const groups = menuRegistry.getContextActions(menuId, scopedContext);
    if (groups.length === 0) {
        if (contextMenu.visible) {
            contextMenu = { ...contextMenu, visible: false };
        }
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    contextMenu = {
        visible: true,
        x: event.clientX,
        y: event.clientY,
        groups,
        payload: context,
    };
}

function closeContextMenu(): void {
    contextMenu = { ...contextMenu, visible: false };
}

function handleMenuSelect(command: string): void {
    dispatchAction(command, contextMenu.payload);
    closeContextMenu();
}

$effect(() => {
    post({ type: 'ready' });
});
</script>

<svelte:window oncontextmenu={handleWindowContextMenu} />

{#if mode === 'repos'}
    <div class="repos-root" data-testid="jj-repos-root">
        {#if repos.length === 0}
            <div class="empty-state" data-testid="jj-repos-empty">
                <p>No Jujutsu repositories detected.</p>
                <p class="hint">Open a folder containing a <code>.jj</code> directory.</p>
            </div>
        {:else}
            <div class="repo-list" role="list">
                {#each repos as repo (repo.root)}
                    <div
                        class="repo-row"
                        class:is-focused={repo.root === focusedRoot}
                        role="listitem"
                        data-testid="jj-repo-row"
                    >
                        <button
                            type="button"
                            class="repo-entry"
                            title={repo.root}
                            onclick={() => focusRepository(repo.root)}
                        >
                            <i class="codicon codicon-repo" aria-hidden="true"></i>
                            <span class="repo-name">{repo.name}</span>
                        </button>
                        {#if repo.conflictCount > 0}
                            <span class="badge badge-conflict" title={`${repo.conflictCount} conflicts`}>
                                {repo.conflictCount}
                            </span>
                        {/if}
                        {#if repo.changeCount > 0}
                            <span class="badge" title={`${repo.changeCount} changes`}>{repo.changeCount}</span>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{:else}
    <div class="changes-root" data-testid="jj-changes-root">
        {#if !focusedRoot}
            <div class="empty-state" data-testid="jj-changes-empty">
                <p>No repository selected.</p>
                <p class="hint">Select a repository in the Repositories view.</p>
            </div>
        {:else}
            <ScmPane
                {snapshot}
                workspaceRoot={focusedRoot}
                {menuRegistry}
                {rootContext}
                {openDiffOnClick}
                showHeader={false}
                compactInput
                {viewMode}
                onOpenResource={(state) => openResource(state)}
                onDescriptionChange={(message) =>
                    post({ type: 'draft', payload: { root: focusedRoot, description: message } })}
                onCommit={(message) => post({ type: 'commit', payload: { root: focusedRoot, description: message } })}
                onSetDescription={(message) =>
                    post({ type: 'setDescription', payload: { root: focusedRoot, description: message } })}
                onAction={(command, payload) => dispatchAction(command, payload)}
            />
        {/if}
    </div>
{/if}

{#if contextMenu.visible}
    {#key `${contextMenu.x}:${contextMenu.y}`}
        <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            groups={contextMenu.groups}
            onSelect={handleMenuSelect}
            onClose={closeContextMenu}
        />
    {/key}
{/if}

<style>
.repos-root,
.changes-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow-y: auto;
    background-color: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
}

.repo-list {
    display: flex;
    flex-direction: column;
}

.repo-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px 0 0;
    min-height: 22px;
}

.repo-row:hover {
    background-color: var(--vscode-list-hoverBackground);
}

.repo-row.is-focused {
    background-color: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.repo-entry {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.repo-entry .codicon {
    color: var(--vscode-icon-foreground);
    flex-shrink: 0;
}

.repo-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.badge {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background-color: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    line-height: 16px;
    text-align: center;
}

.badge-conflict {
    background-color: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editor-background, #000);
}

.changes-root :global(.scm-pane) {
    height: auto;
    overflow: visible;
}

.empty-state {
    padding: 16px;
    color: var(--vscode-descriptionForeground);
}

.empty-state .hint {
    font-size: 12px;
    opacity: 0.8;
}
</style>
