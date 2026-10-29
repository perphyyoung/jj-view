/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JjResourceState } from '../../../src/core/scm-resource-state';

export interface FileTreeFileNode {
    readonly type: 'file';
    readonly name: string;
    readonly path: string;
    readonly state: JjResourceState;
}

export interface FileTreeFolderNode {
    readonly type: 'folder';
    readonly name: string;
    readonly path: string;
    readonly children: FileTreeNode[];
}

export type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

export function getResourceRelativePath(state: JjResourceState, workspaceRoot?: string): string {
    if (state.relativePath) {
        return state.relativePath;
    }
    const fullPath = state.resourceUri.path || '';
    if (workspaceRoot && fullPath.startsWith(workspaceRoot)) {
        return fullPath.slice(workspaceRoot.length).replace(/^[/\\]+/, '');
    }
    return fullPath;
}

function sortChildren(children: FileTreeNode[]): void {
    children.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'folder' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    for (const child of children) {
        if (child.type === 'folder') {
            sortChildren(child.children);
        }
    }
}

/** Separator used when collapsing single-child folder chains, e.g. `src \ core \ webview`. */
export const COMPACTED_FOLDER_SEPARATOR = ' \\ ';

/**
 * Collapses folder chains that contain a single sub-folder into one row, mirroring
 * the native SCM tree ("compact folders") rendering.
 */
function compactFolderChains(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
        if (node.type !== 'folder') {
            return node;
        }

        let name = node.name;
        let current: FileTreeFolderNode = node;
        while (current.children.length === 1 && current.children[0].type === 'folder') {
            const onlyChild = current.children[0];
            name = `${name}${COMPACTED_FOLDER_SEPARATOR}${onlyChild.name}`;
            current = onlyChild;
        }

        return {
            type: 'folder',
            name,
            path: current.path,
            children: compactFolderChains(current.children),
        };
    });
}

/**
 * Builds a folder tree from a flat list of changed files, mirroring the native
 * "View as Tree" rendering of the SCM view.
 */
export function buildFileTree(items: readonly JjResourceState[], workspaceRoot?: string): FileTreeNode[] {
    const root: FileTreeFolderNode = { type: 'folder', name: '', path: '', children: [] };

    for (const state of items) {
        const relativePath = getResourceRelativePath(state, workspaceRoot);
        const segments = relativePath.split(/[/\\]/).filter(Boolean);
        if (segments.length === 0) {
            continue;
        }

        let current = root;
        for (let index = 0; index < segments.length - 1; index++) {
            const name = segments[index];
            const path = segments.slice(0, index + 1).join('/');
            let folder = current.children.find(
                (node): node is FileTreeFolderNode => node.type === 'folder' && node.name === name,
            );
            if (!folder) {
                folder = { type: 'folder', name, path, children: [] };
                current.children.push(folder);
            }
            current = folder;
        }

        current.children.push({
            type: 'file',
            name: segments[segments.length - 1],
            path: relativePath,
            state,
        });
    }

    sortChildren(root.children);
    return compactFolderChains(root.children);
}
