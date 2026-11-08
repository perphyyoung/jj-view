/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService getChanges (single revision file changes)', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('correctly identifies files with spaces in their names', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file with a space.txt': 'hello\n' } }]);

        const changes = await jjService.getChanges(ids.v1.changeId);

        expect(changes).toEqual([
            {
                path: 'file with a space.txt',
                status: 'added',
                conflicted: false,
                additions: 1,
                deletions: 0,
            },
        ]);
    });

    test('handles additions, modifications, deletions, and line counts accurately', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'modified.txt': 'line1\nline2\n', 'deleted.txt': 'goodbye\n' } },
            {
                label: 'child',
                parents: ['base'],
                files: {
                    'added.txt': 'new line 1\nnew line 2\n',
                    'modified.txt': 'line1\nmodified line 2\nline3\n',
                },
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.deleteFile('deleted.txt');

        const changes = await jjService.getChanges(ids.child.changeId);
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            {
                path: 'added.txt',
                status: 'added',
                conflicted: false,
                additions: 2,
                deletions: 0,
            },
            {
                path: 'deleted.txt',
                status: 'deleted',
                conflicted: false,
                additions: 0,
                deletions: 1,
            },
            {
                path: 'modified.txt',
                status: 'modified',
                conflicted: false,
                additions: 2,
                deletions: 1,
            },
        ]);
    });

    test('correctly calculates additions and deletions for renamed files', async () => {
        const oldFile = 'old_name.txt';
        const newFile = 'new_name.txt';
        const baseContent = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10);
        const modifiedContent = `${baseContent}line_added_1\nline_added_2\n`;

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldFile]: baseContent } },
            {
                label: 'child',
                parents: ['base'],
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldFile, newFile);
        repo.writeFile(newFile, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newFile);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newFile,
            status: 'renamed',
            oldPath: oldFile,
            additions: 2,
            deletions: 0,
        });
    });

    test('calculates additions and deletions for files in renamed directories', async () => {
        const oldDir = 'old_dir/nested/file.txt';
        const newDir = 'new_dir/nested/file.txt';
        const baseContent = 'line1\nline2\n';
        const modifiedContent = 'line1\nline2\nline3\n';

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldDir]: baseContent } },
            { label: 'child', parents: ['base'] },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldDir, newDir);
        repo.writeFile(newDir, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newDir);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newDir,
            status: 'renamed',
            oldPath: oldDir,
            additions: 1,
            deletions: 0,
        });
    });

    test('caches results and deduplicates concurrent in-flight requests', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file1.txt': 'initial\n' } },
            { label: 'child', parents: ['base'], files: { 'file1.txt': 'updated\n', 'file2.txt': 'created\n' } },
        ]);
        const commitId = ids.child.commitId;

        // Concurrent calls (thundering herd)
        const [changes1, changes2] = await Promise.all([
            jjService.getChanges(commitId),
            jjService.getChanges(commitId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1.length).toBe(2);

        // Subsequent cached call
        const changes3 = await jjService.getChanges(commitId);
        expect(changes3).toEqual(changes1);
    });

    test('invalidates cache on clearCache or mutation', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'test.txt': 'v1\n' } },
            { label: 'child', parents: ['base'], files: { 'test.txt': 'v2\n' } },
        ]);

        const initialChanges = await jjService.getChanges(ids.child.changeId);
        expect(initialChanges.length).toBe(1);
        expect(initialChanges[0].path).toBe('test.txt');

        // Make mutation in child commit using repo
        repo.edit(ids.child.changeId);
        await repo.writeFiles({ 'extra.txt': 'new\n' });

        // Before clearCache / mutation, calling getChanges with cached key without clearCache would return old entries
        // Running status (which is a mutation in JjService) or explicit clearCache invalidates the cache
        await jjService.clearCache();

        const updatedChanges = await jjService.getChanges(ids.child.changeId);
        expect(updatedChanges.length).toBe(2);
        const paths = updatedChanges.map((c) => c.path).sort();
        expect(paths).toEqual(['extra.txt', 'test.txt']);
    });
});
