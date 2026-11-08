/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService Unit Tests', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    describe('new command', () => {
        test('creates a new change', async () => {
            const oldChangeId = repo.getChangeId('@');

            await jjService.new({ message: 'message' });

            const newChangeId = repo.getChangeId('@');
            const description = repo.getDescription('@');
            const parents = repo.getParents('@');

            expect(newChangeId).not.toBe(oldChangeId);
            expect(description).toContain('message');
            // Default `jj new` creates a child of the current working copy
            expect(parents[0]).toBe(oldChangeId);
        });
    });

    test('describe command updates description', async () => {
        const description = 'test description update';
        await jjService.describe(description);

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe(description);
    });

    test('cat command returns file content', async () => {
        await buildGraph(repo, [
            { label: 'v1', description: 'v1', files: { 'file.txt': 'version 1' } },
            { parents: ['v1'], files: { 'file.txt': 'version 2' }, isCurrentWorkingCopy: true },
        ]);

        // cat @- should return "version 1"
        const content = await jjService.cat('file.txt', '@-');
        expect(content).toBe('version 1');
    });

    test('cat command preserves trailing newline', async () => {
        repo.writeFile('newline.txt', 'line\n');
        repo.describe('newline');

        const content = await jjService.cat('newline.txt', '@');
        expect(content).toBe('line\n');
    });

    test('restore command reverts changes', async () => {
        const filePath = path.join(repo.path, 'file.txt');
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'initial' } },
            { parents: ['initial'], files: { 'file.txt': 'modified' }, isCurrentWorkingCopy: true },
        ]);
        await jjService.restore([filePath]);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toBe('initial');
    });

    test('getChildren returns correct children', async () => {
        // Setup: Parent -> Child1
        //                -> Child2
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            {
                label: 'child2',
                parents: ['parent'],
                description: 'child2',
            },
        ]);
        const parentId = ids.parent.changeId;

        const children = await jjService.getChildren(parentId);
        expect(children.length).toBe(2);
    });

    test('getLog parses parents correctly', async () => {
        // Pre-built graph: copied from the worker template, so no `jj new` is needed here.
        await repo.initWithGraph('parent-child', [
            { label: 'parent', description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);

        const [logEntry] = await jjService.getLog({ revision: '@' });
        expect(logEntry.parents).toBeDefined();
        expect(Array.isArray(logEntry.parents)).toBe(true);
        expect(logEntry.parents.length).toBeGreaterThan(0);

        // Check structure of parents
        const parent = logEntry.parents[0];

        expect(typeof parent).toBe('object');
        expect(parent).toHaveProperty('commit_id');
        expect(parent).toHaveProperty('change_id');
        expect(parent).toHaveProperty('is_immutable');
    });

    test('squashRevision with paths moves changes to child', async () => {
        const file1 = 'file1.txt';
        const file2 = 'file2.txt';
        const filePath1 = path.join(repo.path, file1);

        await buildGraph(repo, [
            {
                label: 'grandparent',
                description: 'grandparent',
                files: { [file1]: 'base1\n', [file2]: 'base2\n' },
            },
            {
                label: 'parent',
                parents: ['grandparent'],
                description: 'parent',
                files: { [file1]: 'modified1 in parent', [file2]: 'modified2 in parent' },
            },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                isCurrentWorkingCopy: true,
            },
        ]);

        // Squash ONLY file1 to child
        await jjService.squashRevision({ paths: [filePath1], revision: '@-', intoRevision: '@' });

        // File 1 should be squashed (back to base in parent, modified in child)
        expect(repo.getFileContent('@-', file1).trim()).toBe('base1');
        expect(repo.getFileContent('@', file1)).toBe('modified1 in parent');

        // File 2 should NOT be squashed (still modified in parent)
        expect(repo.getFileContent('@-', file2)).toBe('modified2 in parent');
        // Child inherits File 2 from parent
        expect(repo.getFileContent('@', file2)).toBe('modified2 in parent');
    }, 30000);

    test('getLog without revisions returns multiple entries', async () => {
        await repo.initWithGraph('three-linear', [
            { label: 'c1', description: 'c1' },
            { label: 'c2', parents: ['c1'], description: 'c2' },
            { label: 'c3', parents: ['c2'], description: 'c3' },
        ]);

        const logs = await jjService.getLog();
        expect(logs.length).toBeGreaterThanOrEqual(3);
    });

    test('getLog parses extended fields', async () => {
        await repo.initWithGraph('single-commit', [{ label: 'c', description: 'test fields' }]);
        const [log] = await jjService.getLog({ revision: '@' });

        expect(log.change_id_shortest).toBeDefined();
        expect(log.is_immutable).toBeDefined();
        expect(log.is_empty).toBeDefined();

        expect(log.is_immutable).toBe(false);
        expect(log.is_empty).toBe(true);

        const shortestId = log.change_id_shortest;
        if (!shortestId) {
            throw new Error('change_id_shortest not found');
        }
        expect(log.change_id.startsWith(shortestId)).toBe(true);
        expect(log.change_id_shortest?.length).toBeGreaterThan(0);
        expect(log.change_id_shortest?.length).toBeLessThan(log.change_id.length);
    });

    test('getLog populates nearest_visible_ancestors with gaps', async () => {
        // Setup: A -> B -> C -> D
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'commit A' },
            { label: 'B', parents: ['A'], description: 'commit B' },
            { label: 'C', parents: ['B'], description: 'commit C' },
            { label: 'D', parents: ['C'], description: 'commit D' },
        ]);

        const idA = ids.A.changeId;
        const idD = ids.D.changeId;

        // Fetch only A and D. B and C are "missing".
        // Nearest visible ancestor of D in (A|D) should be A.
        const logs = await jjService.getLog({
            revision: `(${idA} | ${idD})`,
            includeNearestVisibleAncestors: true,
        });

        const logD = logs.find((l) => l.change_id === idD);
        const logA = logs.find((l) => l.change_id === idA);

        expect(logD).toBeDefined();
        expect(logA).toBeDefined();

        // Immediate parent of D is C
        expect(logD?.parents[0].commit_id).toBe(ids.C.commitId);
        expect(logD?.parents[0].change_id).toBe(ids.C.changeId);

        // Nearest visible ancestor of D in (A|D) is A
        expect(logD?.nearest_visible_ancestors).toContain(idA);
        expect(logD?.nearest_visible_ancestors?.length).toBe(1);

        // A's nearest visible ancestors should be empty (no ancestors in (A|D))
        expect(logA?.nearest_visible_ancestors?.length).toBe(0);
    });

    test('getLog does not populate nearest_visible_ancestors by default', async () => {
        repo.describe('test');
        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.nearest_visible_ancestors).toBeUndefined();
    });

    test('getLog detects empty status correctly', async () => {
        const ids = await repo.initWithGraph('not-empty-then-empty', [
            { label: 'notEmpty', description: 'not empty', files: { 'not-empty.txt': 'content' } },
            { label: 'emptyChild', parents: ['notEmpty'], description: 'empty child' },
        ]);

        const [notEmpty] = await jjService.getLog({ revision: ids.notEmpty.changeId });
        expect(notEmpty.is_empty).toBe(false);

        const [emptyLog] = await jjService.getLog({ revision: ids.emptyChild.changeId });
        expect(emptyLog.is_empty).toBe(true);
    });

    test('getLog parses parents_immutable correctly', async () => {
        // Not templated: the assertion depends on the repository's own initial root commit
        // (the parent of `@`), which a freshly built graph does not have.
        repo.describe('child of root');
        const [child] = await jjService.getLog({ revision: '@' });

        expect(child.parents).toBeDefined();
        expect(child.parents.length).toBeGreaterThan(0);
        expect(child.parents[0].is_immutable).toBe(true);

        repo.new(['@'], 'grandchild');
        const [grandchild] = await jjService.getLog({ revision: '@' });

        expect(grandchild.parents).toBeDefined();
        expect(grandchild.parents[0].is_immutable).toBe(false);
    });

    test('getLog parses tags correctly', async () => {
        const ids = await repo.initWithGraph('tagged-commit', [
            { label: 'commit', description: 'tagged commit', tags: ['test-tag-1', 'test-tag-2'] },
            { label: 'child', parents: ['commit'], description: 'child commit' },
        ]);

        const changeId = ids.commit.changeId;
        const [log] = await jjService.getLog({ revision: changeId });

        expect(log.tags).toBeDefined();
        expect(Array.isArray(log.tags)).toBe(true);
        expect(log.tags).toContain('test-tag-1');
        expect(log.tags).toContain('test-tag-2');
        expect(log.tags?.length).toBe(2);
    });

    test('getLog parses author and committer with full details', async () => {
        await repo.initWithGraph('single-commit', [{ label: 'c', description: 'author test' }]);
        const [log] = await jjService.getLog({ revision: '@' });

        // Verify author structure (values may come from global jj config, not repo-local)
        expect(typeof log.author).toBe('object');
        expect(typeof log.author.name).toBe('string');
        expect(log.author.name.length).toBeGreaterThan(0);
        expect(log.author.email).toContain('@');

        // Verify committer has correct values (from TestRepo repo-local config)
        expect(log.committer?.name).toBe('Test User');
        expect(log.committer?.email).toBe('test@example.com');

        // Verify timestamps are valid ISO 8601 format and parseable
        const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
        expect(log.author.timestamp).toMatch(isoPattern);
        expect(log.committer.timestamp).toMatch(isoPattern);

        // Verify timestamps are actual parseable dates
        const authorDate = new Date(log.author.timestamp);
        const committerDate = new Date(log.committer.timestamp);
        expect(authorDate.getTime()).not.toBeNaN();
        expect(committerDate.getTime()).not.toBeNaN();
    });

    test('duplicate command creates copy', async () => {
        repo.describe('original');
        const originalChangeId = repo.getChangeId('@');

        await jjService.duplicate(originalChangeId);

        const logs = repo.getLog('all()', 'change_id ++ " " ++ description').split('\n');
        const duplicates = logs.filter((l) => l.includes('original'));
        expect(duplicates.length).toBeGreaterThanOrEqual(2);
    });

    test('duplicate command with onto creates copy with target as parent', async () => {
        repo.describe('target-parent');
        const targetId = repo.getChangeId('@');
        repo.new(['root()']);
        repo.describe('to-duplicate');
        const sourceId = repo.getChangeId('@');

        await jjService.duplicate(sourceId, { onto: targetId });

        const logs = repo.getLog('all()', 'change_id ++ " " ++ description').split('\n');
        const duplicates = logs.filter((l) => l.includes('to-duplicate'));
        expect(duplicates.length).toBeGreaterThanOrEqual(2);

        // Find the duplicate changeId (not equal to sourceId)
        const duplicateEntry = duplicates.find((l) => !l.startsWith(sourceId));
        expect(duplicateEntry).toBeDefined();
        if (duplicateEntry) {
            const dupChangeId = duplicateEntry.split(' ')[0];
            const parents = repo.getParents(dupChangeId);
            expect(parents).toContain(targetId);
        }
    });

    test('abandon command removes revision', async () => {
        repo.describe('to-abandon');
        const changeId = repo.getChangeId('@');
        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe('to-abandon');

        await jjService.abandon('@');

        const newChangeId = repo.getChangeId('@');
        expect(newChangeId).not.toBe(changeId);
        const log = repo.getLog('all()', 'change_id');
        expect(log).not.toContain(changeId);
    });

    test('showDetails returns string signature', async () => {
        repo.describe('details test');
        const output = await jjService.showDetails('@');
        expect(output).toContain('details test');
        expect(typeof output).toBe('string');
    });

    test('getLog handles complex graph (forks)', async () => {
        await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'parent', parents: ['root'], description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            { label: 'child2', parents: ['parent'], description: 'child2', isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();

        expect(logs.length).toBeGreaterThanOrEqual(4);

        const child1Log = logs.find((l) => l.description.trim() === 'child1');
        const child2Log = logs.find((l) => l.description.trim() === 'child2');
        const parentLog = logs.find((l) => l.description.trim() === 'parent');

        expect(child1Log).toBeDefined();
        expect(child2Log).toBeDefined();
        expect(parentLog).toBeDefined();

        expect(child1Log?.parents[0].commit_id).toBe(parentLog?.commit_id);
        expect(child2Log?.parents[0].commit_id).toBe(parentLog?.commit_id);
    }, 30000);

    test('Complex Replay (Reproduce User Scenario) with return IDs', async () => {
        const { Initial, FakeTS, CC, Cool, VPM, Orcs, HEAD } = await buildGraph(repo, [
            {
                label: 'Initial',
                description: 'initial commit',
            },
            {
                label: 'FakeTS',
                parents: ['Initial'],
                description: 'Added a fake ts file',
            },
            {
                label: 'CC',
                parents: ['FakeTS'],
                description: 'cc file and stuff',
            },
            {
                label: 'Cool',
                parents: ['Initial'],
                description: "It's pretty cool I guess",
            },
            {
                label: 'VPM',
                parents: ['Cool'],
                description: 'vpmososp',
            },
            {
                label: 'Orcs',
                parents: ['Cool'],
                description: 'Orcs are coming',
            },
            {
                label: 'HEAD',
                parents: ['VPM'],
                description: 'tqlynzyq',
                isCurrentWorkingCopy: true,
            },
        ]);

        const headId = HEAD.changeId;

        repo.edit(headId);
        const logs = await jjService.getLog();

        const getDesc = (id: string) => logs.find((l) => l.change_id === id)?.description.trim();
        const getParents = (id: string) => {
            const entry = logs.find((l) => l.change_id === id);
            if (!entry) {
                return [];
            }
            return entry.parents
                .map((p) => {
                    const parentLog = logs.find((l) => l.commit_id === p.commit_id);
                    return parentLog ? parentLog.change_id : undefined;
                })
                .filter(Boolean);
        };

        const initialId = Initial.changeId;
        const fakeTSId = FakeTS.changeId;
        const ccId = CC.changeId;
        const coolId = Cool.changeId;
        const vpmId = VPM.changeId;
        const orcsId = Orcs.changeId;
        const headChangeId = HEAD.changeId;

        expect(getDesc(initialId)).toContain('initial commit');
        expect(getDesc(fakeTSId)).toContain('Added a fake ts file');
        expect(getDesc(ccId)).toContain('cc file');
        expect(getDesc(coolId)).toContain('pretty cool');
        expect(getDesc(vpmId)).toContain('vpmososp');
        expect(getDesc(headChangeId)).toContain('tqlynzyq');
        expect(getDesc(orcsId)).toContain('Orcs');

        expect(getParents(fakeTSId)).toContain(initialId);
        expect(getParents(coolId)).toContain(initialId);
        expect(getParents(ccId)).toContain(fakeTSId);
        expect(getParents(vpmId)).toContain(coolId);
        expect(getParents(orcsId)).toContain(coolId);
        expect(getParents(headChangeId)).toContain(vpmId);
    }, 30000);

    test('describe with revision updates specific commit', async () => {
        const jj = new JjService(repo.path, NO_OP_LOGGER);
        repo.new([], 'parent');
        const parentId = repo.getChangeId('@');
        repo.new([], 'child');

        await jj.describe('updated parent', parentId);

        const parentLog = repo.getDescription(parentId);
        expect(parentLog.trim()).toBe('updated parent');
    });

    test('getDescription fetches full description', async () => {
        repo.describe('multiline\ndescription\ntest');
        const desc = await jjService.getDescription('@');
        expect(desc.trim()).toBe('multiline\ndescription\ntest');
    });

    test('getConflictedFiles returns conflicted paths', async () => {
        await buildGraph(repo, [
            { label: 'base', description: 'base', files: { 'conflict.txt': 'base\n' } },
            { label: 'left', parents: ['base'], description: 'left', files: { 'conflict.txt': 'left\n' } },
            { label: 'right', parents: ['base'], description: 'right', files: { 'conflict.txt': 'right\n' } },
            { label: 'merge', parents: ['left', 'right'], description: 'merge', isCurrentWorkingCopy: true },
        ]);

        const conflictedFiles = await jjService.getConflictedFiles();
        expect(conflictedFiles).toEqual(['conflict.txt']);
    });

    test('getLog returns file changes with statuses', async () => {
        await buildGraph(repo, [
            {
                label: 'setup',
                description: 'setup',
                files: { 'modified.txt': 'initial', 'deleted.txt': 'to delete' },
            },
            { parents: ['setup'], isCurrentWorkingCopy: true },
        ]);

        // Operations
        repo.writeFile('added.txt', 'new'); // Added
        repo.writeFile('modified.txt', 'modified'); // Modified
        repo.deleteFile('deleted.txt'); // Deleted

        const [log] = await jjService.getLog({ revision: '@' });
        const changes = log.changes;
        if (!changes) {
            throw new Error('changes not found');
        }

        const added = changes.find((c) => c.path === 'added.txt');
        const modified = changes.find((c) => c.path === 'modified.txt');
        const deleted = changes.find((c) => c.path === 'deleted.txt');

        expect(added).toBeDefined();
        expect(added?.status).toBe('added');

        expect(modified).toBeDefined();
        expect(modified?.status).toBe('modified');

        expect(deleted).toBeDefined();
        expect(deleted?.status).toBe('deleted');
    });

    test('getWorkingCopyChanges detects renamed file', async () => {
        const oldFile = 'old-rename.txt';
        const newFile = 'new-rename.txt';
        const content = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10); // Sufficient content for similarity

        // Create file in parent
        repo.writeFile(oldFile, content);
        repo.describe('parent');

        // Start new change
        await jjService.new();

        repo.moveFile(oldFile, newFile);

        const changes = await jjService.getWorkingCopyChanges();

        // We expect jj to detect this as a rename because content is identical and large enough
        expect(changes.length).toBe(1);
        expect(changes[0].status).toBe('renamed');
        expect(changes[0].path).toBe(newFile);
        expect(changes[0].oldPath).toBe(oldFile);
    });

    test('getLog includes oldPath for renamed files', async () => {
        const oldFile = 'old-log-rename.txt';
        const newFile = 'new-log-rename.txt';
        repo.writeFile(oldFile, 'log rename content');
        repo.describe('parent');
        await jjService.new();
        repo.moveFile(oldFile, newFile);

        const [logEntry] = await jjService.getLog({ revision: '@' });
        expect(logEntry).toBeDefined();

        const changes = logEntry.changes || [];
        const renameEntry = changes.find((c) => c.path === newFile);
        expect(renameEntry).toBeDefined();
        expect(renameEntry?.status).toBe('renamed');
        expect(renameEntry?.oldPath).toBe(oldFile);
    });

    test('commit runs jj commit', async () => {
        // Setup state: Make a change
        repo.writeFile('file.txt', 'content');

        await jjService.commit('my commit message');

        // Verification:
        // 1. Current working copy (@) should be empty/new
        // 2. Parent (@-) should have the message "my commit message"

        const [head] = await jjService.getLog({ revision: '@' });
        const [parent] = await jjService.getLog({ revision: '@-' });

        expect(head.description).toBe('');
        expect(parent.description.trim()).toBe('my commit message');
    });

    test('getLog handles atypical workspace names', async () => {
        const alphaRepo = repo.workspaceAdd('alpha:1.0', undefined, path.join(repo.path, 'alpha_1.0'));
        alphaRepo.new();

        const logEntries = await jjService.getLog({ revision: alphaRepo.getWorkingCopyId() });

        expect(logEntries.length).toBeGreaterThan(0);
        const head = logEntries[0];
        expect(head.working_copies).toContain('alpha:1.0');
    });
});
