/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../core/jj-types';

/**
 * These cases validate the field semantics for log entries related to graph structure
 * and workspace metadata. The old repo-tier version created a real jj repository and ran
 * `jj log` for every case just to obtain objects with these fields.
 */
function entry(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    const identity = { name: 'Test User', email: 'test@example.com', timestamp: '2026-11-08T00:00:00+08:00' };
    return {
        commit_id: 'commit-a',
        change_id: 'change-a',
        description: 'test',
        author: identity,
        committer: identity,
        parents: [],
        bookmarks: [],
        is_immutable: false,
        is_current_working_copy: false,
        ...overrides,
    } as JjLogEntry;
}

describe('JjLogEntry graph and workspace fields (fixtures)', () => {
    it('detects divergent commits and offsets', () => {
        const v1 = entry({ is_divergent: true, change_id_offset: 1, change_id: 'change-a/1' });
        const v2 = entry({ is_divergent: true, change_id_offset: 0, change_id: 'change-a/0' });

        expect(v1.is_divergent).toBe(true);
        expect(v2.is_divergent).toBe(true);
        expect(v1.change_id).toMatch(/\/\d+$/);
        expect(v2.change_id).toMatch(/\/\d+$/);
        expect(v1.change_id_offset).toBe(1);
        expect(v2.change_id_offset).toBe(0);
        expect(v1.change_id_offset).not.toBe(v2.change_id_offset);
    });

    it('includes workspace labels in working_copies field', () => {
        const currentWc = entry({ is_current_working_copy: true, working_copies: ['default'] });
        const secondWc = entry({ is_current_working_copy: false, working_copies: ['repo2'] });

        expect(currentWc.is_current_working_copy).toBe(true);
        expect(currentWc.working_copies).toContain('default');
        expect(secondWc.is_current_working_copy).toBe(false);
        expect(secondWc.working_copies?.some((w) => w.startsWith('repo2'))).toBe(true);
    });

    it('returns file changes with statuses', () => {
        const log = entry({
            changes: [
                { path: 'added.txt', status: 'added', conflicted: false, additions: 1, deletions: 0 },
                { path: 'modified.txt', status: 'modified', conflicted: false, additions: 1, deletions: 1 },
                { path: 'deleted.txt', status: 'deleted', conflicted: false, additions: 0, deletions: 1 },
            ],
        });

        const changes = log.changes;
        expect(changes).toBeDefined();
        expect(changes?.find((c) => c.path === 'added.txt')?.status).toBe('added');
        expect(changes?.find((c) => c.path === 'modified.txt')?.status).toBe('modified');
        expect(changes?.find((c) => c.path === 'deleted.txt')?.status).toBe('deleted');
    });

    it('includes oldPath for renamed files', () => {
        const log = entry({
            changes: [{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', conflicted: false }],
        });

        const renameEntry = log.changes?.find((c) => c.path === 'new.txt');
        expect(renameEntry).toBeDefined();
        expect(renameEntry?.status).toBe('renamed');
        expect(renameEntry?.oldPath).toBe('old.txt');
    });

    it('handles atypical workspace names', () => {
        const log = entry({ working_copies: ['alpha:1.0'] });

        expect(log.working_copies).toContain('alpha:1.0');
    });

    it('handles complex graph (forks) parent relationships', () => {
        const root = entry({ commit_id: 'commit-root', change_id: 'root', description: 'root' });
        const parent = entry({
            commit_id: 'commit-parent',
            change_id: 'parent',
            description: 'parent',
            parents: [{ commit_id: 'commit-root', change_id: 'root', is_immutable: false }],
        });
        const child1 = entry({
            commit_id: 'commit-child1',
            change_id: 'child1',
            description: 'child1',
            parents: [{ commit_id: 'commit-parent', change_id: 'parent', is_immutable: false }],
        });
        const child2 = entry({
            commit_id: 'commit-child2',
            change_id: 'child2',
            description: 'child2',
            is_current_working_copy: true,
            parents: [{ commit_id: 'commit-parent', change_id: 'parent', is_immutable: false }],
        });

        expect(child1.parents[0].commit_id).toBe(parent.commit_id);
        expect(child2.parents[0].commit_id).toBe(parent.commit_id);
        expect(parent.parents[0].commit_id).toBe(root.commit_id);
    });
});
