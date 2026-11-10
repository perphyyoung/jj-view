/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjStatusEntry } from '../core/jj-types';
import { createJjResourceState } from '../core/scm-resource-state';
import { buildFileTree, collectFilePaths } from '../core/webview/ui/scm/file-tree';
import { createUntrackPayload } from '../vscode/payloads/untrack.payload';

const entry = (path: string): JjStatusEntry => ({ path, status: 'modified' }) as JjStatusEntry;

describe('createUntrackPayload', () => {
    it('collects repository-relative paths from resource states', () => {
        const state = createJjResourceState(entry('src/a.ts'), '@', '/repo');
        expect(createUntrackPayload([state]).paths).toEqual(['src/a.ts']);
    });

    it('accepts a tree folder payload and keeps the folder path', () => {
        const payload = createUntrackPayload([{ root: '/repo', paths: ['src/a.ts', 'src/b.ts'], folder: 'src' }]);
        expect(payload).toEqual({ paths: ['src/a.ts', 'src/b.ts'], folder: 'src' });
    });

    it('deduplicates and drops empty paths', () => {
        const payload = createUntrackPayload([{ paths: ['a.ts', 'a.ts', '', '  '] }]);
        expect(payload.paths).toEqual(['a.ts']);
    });
});

describe('collectFilePaths', () => {
    it('returns every file under a folder node', () => {
        const tree = buildFileTree(
            [
                createJjResourceState(entry('src/a.ts'), '@', '/repo'),
                createJjResourceState(entry('src/nested/b.ts'), '@', '/repo'),
            ],
            '/repo',
        );
        const paths = collectFilePaths(tree[0]);
        expect(paths).toHaveLength(2);
        expect(paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/nested/b.ts']));
    });
});
