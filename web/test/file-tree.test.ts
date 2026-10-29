/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createJjResourceState } from '../../src/core/scm-resource-state';
import { buildFileTree, type FileTreeFolderNode, getResourceRelativePath } from '../src/scm/file-tree';

function state(path: string) {
    return createJjResourceState({ path, status: 'modified' }, '@', '/repo');
}

describe('buildFileTree', () => {
    it('groups files by folder and puts folders before files', () => {
        const tree = buildFileTree([state('src/b.ts'), state('src/a.ts'), state('README.md')], '/repo');

        expect(tree.map((node) => node.name)).toEqual(['src', 'README.md']);

        const folder = tree[0] as FileTreeFolderNode;
        expect(folder.type).toBe('folder');
        expect(folder.children.map((node) => node.name)).toEqual(['a.ts', 'b.ts']);
        expect(folder.children.every((node) => node.type === 'file')).toBe(true);
    });

    it('nests multiple folder levels and reuses existing folders', () => {
        const tree = buildFileTree(
            [state('src/core/deep/a.ts'), state('src/core/b.ts'), state('src/other/c.ts')],
            '/repo',
        );

        expect(tree).toHaveLength(1);
        const src = tree[0] as FileTreeFolderNode;
        expect(src.name).toBe('src');
        expect(src.children.map((node) => node.name)).toEqual(['core', 'other']);

        const core = src.children[0] as FileTreeFolderNode;
        expect(core.children.map((node) => node.name)).toEqual(['deep', 'b.ts']);
    });

    it('collapses single-child folder chains into a single row', () => {
        const tree = buildFileTree([state('a/b/c/file.ts')], '/repo');

        expect(tree).toHaveLength(1);
        const folder = tree[0] as FileTreeFolderNode;
        expect(folder.name).toBe('a \\ b \\ c');
        expect(folder.children.map((node) => node.name)).toEqual(['file.ts']);
    });

    it('keeps folders separate when they branch or contain files', () => {
        const tree = buildFileTree([state('a/b/one.ts'), state('a/c/two.ts')], '/repo');

        const folder = tree[0] as FileTreeFolderNode;
        expect(folder.name).toBe('a');
        expect(folder.children.map((node) => node.name)).toEqual(['b', 'c']);
    });

    it('returns an empty tree when there are no changes', () => {
        expect(buildFileTree([], '/repo')).toEqual([]);
    });
});

describe('getResourceRelativePath', () => {
    it('prefers relativePath from the resource state', () => {
        expect(getResourceRelativePath(state('src/a.ts'), '/repo')).toBe('src/a.ts');
    });
});
