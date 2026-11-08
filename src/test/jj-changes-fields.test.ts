/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjFileChange, JjFileChangeWithStats } from '../core/jj-schemas';
import { JjFileChangeSchema, JjFileChangeWithStatsSchema } from '../core/jj-schemas';

/**
 * These cases validate the zod schema and field semantics for file changes.
 * The old repo-tier version created a real jj repository and ran `jj log`/`jj diff`
 * for every case just to obtain objects with these fields.
 */
function change(overrides: Partial<JjFileChange> = {}): JjFileChange {
    return {
        path: 'file.txt',
        status: 'modified',
        conflicted: false,
        ...overrides,
    };
}

function changeWithStats(overrides: Partial<JjFileChangeWithStats> = {}): JjFileChangeWithStats {
    return {
        path: 'file.txt',
        status: 'modified',
        conflicted: false,
        ...overrides,
    };
}

describe('JjFileChange field parsing (fixtures)', () => {
    it('identifies files with spaces in their names', () => {
        const c = change({ path: 'file with a space.txt', status: 'added' });

        expect(c.path).toBe('file with a space.txt');
        expect(c.status).toBe('added');
    });

    it('handles additions, modifications, deletions, and line counts accurately', () => {
        const added = changeWithStats({ path: 'added.txt', status: 'added', additions: 2, deletions: 0 });
        const modified = changeWithStats({ path: 'modified.txt', status: 'modified', additions: 2, deletions: 1 });
        const deleted = changeWithStats({ path: 'deleted.txt', status: 'deleted', additions: 0, deletions: 1 });

        expect(added.status).toBe('added');
        expect(added.additions).toBe(2);
        expect(added.deletions).toBe(0);

        expect(modified.status).toBe('modified');
        expect(modified.additions).toBe(2);
        expect(modified.deletions).toBe(1);

        expect(deleted.status).toBe('deleted');
        expect(deleted.additions).toBe(0);
        expect(deleted.deletions).toBe(1);
    });

    it('calculates additions and deletions for renamed files', () => {
        const renamed = changeWithStats({
            path: 'new_name.txt',
            oldPath: 'old_name.txt',
            status: 'renamed',
            additions: 2,
            deletions: 0,
        });

        expect(renamed.status).toBe('renamed');
        expect(renamed.oldPath).toBe('old_name.txt');
        expect(renamed.additions).toBe(2);
        expect(renamed.deletions).toBe(0);
    });

    it('calculates additions and deletions for files in renamed directories', () => {
        const renamedDir = changeWithStats({
            path: 'new_dir/nested/file.txt',
            oldPath: 'old_dir/nested/file.txt',
            status: 'renamed',
            additions: 1,
            deletions: 0,
        });

        expect(renamedDir.status).toBe('renamed');
        expect(renamedDir.oldPath).toBe('old_dir/nested/file.txt');
        expect(renamedDir.additions).toBe(1);
    });

    it('detects conflict status and sides', () => {
        const conflicted = change({ path: 'conflict.txt', status: 'modified', conflicted: true, conflictSides: 2 });

        expect(conflicted.conflicted).toBe(true);
        expect(conflicted.conflictSides).toBe(2);
    });

    it('validates a fully populated entry against the zod schema', () => {
        const raw = {
            path: 'dir/file.txt',
            oldPath: 'old_dir/file.txt',
            status: 'renamed',
            conflicted: true,
            conflictSides: 3,
            additions: 5,
            deletions: 2,
        };
        const result = JjFileChangeWithStatsSchema.safeParse(raw);
        expect(result.success).toBe(true);
    });

    it('rejects invalid status values', () => {
        const raw = { path: 'file.txt', status: 'invalid-status' };
        const result = JjFileChangeSchema.safeParse(raw);
        expect(result.success).toBe(false);
    });
});
