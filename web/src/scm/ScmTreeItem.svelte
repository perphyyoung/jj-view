<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
import type { JjResourceState } from '../../../src/core/scm-resource-state';
import type { IContextKeyService } from '../menu/context-key-service';
import type { MenuRegistry } from '../menu/menu-registry';
import type { FileTreeFolderNode, FileTreeNode } from './file-tree';
import ScmResourceItem from './ScmResourceItem.svelte';
import Self from './ScmTreeItem.svelte';

interface Props {
    node: FileTreeNode;
    depth?: number;
    context: IContextKeyService;
    menuRegistry: MenuRegistry;
    workspaceRoot?: string;
    onOpenResource: (state: JjResourceState, options?: { preview?: boolean }) => void;
    onResourceAction: (command: string, state: JjResourceState) => void;
    onResourceContextMenu?: (event: MouseEvent, state: JjResourceState) => void;
}

let {
    node,
    depth = 0,
    context,
    menuRegistry,
    workspaceRoot,
    onOpenResource,
    onResourceAction,
    onResourceContextMenu,
}: Props = $props();

let expanded = $state(true);

const itemContext = $derived(
    node.type === 'file'
        ? context.createScoped({
              scmResourceState: node.state.contextValue || '',
              resourceFilename: node.name,
              resourceScheme: node.state.resourceUri.scheme,
          })
        : undefined,
);

function toggle(): void {
    expanded = !expanded;
}
</script>

{#if node.type === 'folder'}
    <div
        class="tree-folder"
        data-testid={`scm-tree-folder-${node.path}`}
        role="button"
        tabindex="0"
        style:padding-left={`${depth * 10 + 8}px`}
        onclick={toggle}
        onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                toggle();
            }
        }}
    >
        <span class="chevron">
            <i class={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden="true"></i>
        </span>
        <span class="folder-icon">
            <i class={expanded ? 'codicon codicon-folder-opened' : 'codicon codicon-folder'} aria-hidden="true"></i>
        </span>
        <span class="folder-name" title={node.path}>{node.name}</span>
    </div>
    {#if expanded}
        {#each node.children as child (child.path)}
            <Self
                node={child}
                depth={depth + 1}
                {context}
                {menuRegistry}
                {workspaceRoot}
                {onOpenResource}
                {onResourceAction}
                {onResourceContextMenu}
            />
        {/each}
    {/if}
{:else if itemContext}
    <div class="tree-file" style:padding-left={`${depth * 10 + 8}px`}>
        <ScmResourceItem
            resourceState={node.state}
            {workspaceRoot}
            context={itemContext}
            {menuRegistry}
            showDirName={false}
            onOpen={onOpenResource}
            onAction={onResourceAction}
            onContextMenu={onResourceContextMenu}
        />
    </div>
{/if}

<style>
.tree-folder {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    min-height: 22px;
    padding-right: 8px;
    font-family: var(--vscode-font-family, system-ui, Ubuntu, "Droid Sans", sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground, #d4d4d4));
    cursor: pointer;
    user-select: none;
    box-sizing: border-box;
    overflow: hidden;
}

.tree-folder:hover {
    background-color: var(--vscode-list-hoverBackground, rgba(31, 62, 94, 0.35));
}

.tree-folder:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #69b1ff);
    outline-offset: -1px;
}

.chevron,
.folder-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: var(--vscode-icon-foreground, #c5c5c5);
}

.folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tree-file {
    display: flex;
    flex-direction: column;
}
</style>
