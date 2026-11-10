<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjStatusEntry } from '../../jj-types';
import type { ScmSnapshot } from '../../scm-model';
import type { JjResourceState } from '../../scm-resource-state';
import { useBridge, useMessageListener } from '../transport/bridge.svelte';
import ContextMenu from '../ui/menu/ContextMenu.svelte';
import { ContextKeyService } from '../ui/menu/context-key-service';
import { extractVsCodeContext } from '../ui/menu/context-menu-utils';
import { MenuRegistry } from '../ui/menu/menu-registry';
import type { PackageJsonContributes, ResolvedMenuItemGroup } from '../ui/menu/menu-types';
import ScmPane from '../ui/scm/ScmPane.svelte';

type WireSnapshot = Omit<ScmSnapshot, 'workingCopyStatuses'>;
type ViewMode = 'repos' | 'changes';

interface RepoSummary {
    root: string;
    name: string;
    /** `undefined` until the repository snapshot exists (cold start). */
    changeCount?: number;
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
    /** Change groups to expand for this push only (one shot). */
    revealChangeIds?: string[];
    /** True while the first repository scan is still running. */
    reposLoading?: boolean;
    /** Monotonic provider push sequence; older pushes are dropped. */
    seq?: number;
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

// The view mode is baked into the HTML as `__INITIAL_STATE__` so the correct tree is rendered
// even before (or without) the `ready`/`init` handshake; `undefined` renders a loading state
// instead of guessing `changes`, which previously made the Repositories view render ScmPane.
const initialMode = (() => {
    const el = document.getElementById('__INITIAL_STATE__');
    if (!el?.textContent) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(el.textContent) as { mode?: string };
        return parsed.mode === 'repos' || parsed.mode === 'changes' ? parsed.mode : undefined;
    } catch {
        return undefined;
    }
})();
let mode = $state<ViewMode | undefined>(initialMode);
let repos = $state<RepoSummary[]>([]);
let focusedRoot = $state<string | undefined>(undefined);
let snapshot = $state<ScmSnapshot | undefined>(undefined);
let viewMode = $state<'list' | 'tree'>('list');
let openDiffOnClick = $state(true);
// Starts true: the very first paint must not claim "no repositories" before the scan result.
let reposLoading = $state(true);
let contributionsLoaded = false;

let contextMenu = $state<ContextMenuState>({ visible: false, x: 0, y: 0, groups: [] });

function hydrate(wire: WireSnapshot | undefined): ScmSnapshot | undefined {
    if (!wire) {
        return undefined;
    }
    return { ...(wire as unknown as ScmSnapshot), workingCopyStatuses: new Map() };
}

let lastSeq = 0;
/**
 * Change groups expanded by the latest push only. Each state push overwrites this list,
 * so a split reveals its groups once and later refreshes do not keep re-expanding them.
 */
let revealedChangeIds = $state<string[]>([]);

function applyState(payload: StatePayload): void {
    const seq = payload.seq ?? 0;
    if (seq > 0 && seq < lastSeq) {
        // A slower refresh finished after a newer one; keep the newer UI.
        return;
    }
    lastSeq = Math.max(lastSeq, seq);
    repos = payload.repos ?? [];
    reposLoading = payload.reposLoading ?? false;
    focusedRoot = payload.focusedRoot;
    snapshot = hydrate(payload.snapshot);
    viewMode = payload.viewMode ?? viewMode;
    revealedChangeIds = payload.revealChangeIds ?? [];
}

useMessageListener<Record<string, unknown>>((raw) => {
    const type = raw?.type;
    const payload = raw?.payload as Record<string, unknown> | undefined;
    if (!payload) {
        return;
    }

    if (type === 'init') {
        const init = payload as unknown as InitPayload;
        mode = init.mode ?? mode;
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

    // Tree folders carry their file list instead of a single resource state.
    const paths =
        typeof target === 'object' && target !== null && Array.isArray((target as { paths?: unknown }).paths)
            ? (target as { paths: unknown[] }).paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
            : undefined;
    const folder =
        typeof target === 'object' && target !== null && typeof (target as { folder?: unknown }).folder === 'string'
            ? (target as { folder: string }).folder
            : undefined;
    if (paths && paths.length > 0) {
        post({ type: 'action', payload: { root: focusedRoot, command, paths, ...(folder ? { folder } : {}) } });
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

{#if mode === undefined}
    <div class="empty-state" data-testid="jj-webview-loading">
        <p>Loading…</p>
    </div>
{:else if mode === 'repos'}
    <div class="repos-root" data-testid="jj-repos-root">
        {#if reposLoading}
            <div class="empty-state" data-testid="jj-repos-loading">
                <p>Loading repositories…</p>
            </div>
        {:else if repos.length === 0}
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
                        {#if repo.changeCount === undefined}
                            <span class="badge badge-pending" aria-hidden="true"></span>
                        {:else if repo.changeCount > 0}
                            <span class="badge" title={`${repo.changeCount} changes`}>{repo.changeCount}</span>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}
    </div>
{:else}
    <div class="changes-root" data-testid="jj-changes-root">
        {#if reposLoading}
            <div class="empty-state" data-testid="jj-changes-loading">
                <p>Loading…</p>
            </div>
        {:else if !focusedRoot}
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
                {revealedChangeIds}
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

/* Same footprint as a count badge, so the row does not resize when the count arrives. */
.badge-pending {
    width: 18px;
    height: 10px;
    padding: 0;
    opacity: 0.35;
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
