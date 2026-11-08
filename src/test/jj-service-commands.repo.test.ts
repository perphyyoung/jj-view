/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService commit and file commands', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    // === Commit lifecycle ===

    test('new command creates a new change', async () => {
        const oldChangeId = repo.getChangeId('@');

        await jjService.new({ message: 'message' });

        const newChangeId = repo.getChangeId('@');
        const description = repo.getDescription('@');
        const parents = repo.getParents('@');

        expect(newChangeId).not.toBe(oldChangeId);
        expect(description).toContain('message');
        expect(parents[0]).toBe(oldChangeId);
    });

    test('describe command updates description', async () => {
        const description = 'test description update';
        await jjService.describe(description);

        const desc = repo.getDescription('@');
        expect(desc.trim()).toBe(description);
    });

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

    test('commit runs jj commit', async () => {
        repo.writeFile('file.txt', 'content');

        await jjService.commit('my commit message');

        const [head] = await jjService.getLog({ revision: '@' });
        const [parent] = await jjService.getLog({ revision: '@-' });

        expect(head.description).toBe('');
        expect(parent.description.trim()).toBe('my commit message');
    });

    test('showDetails returns string signature', async () => {
        repo.describe('details test');
        const output = await jjService.showDetails('@');
        expect(output).toContain('details test');
        expect(typeof output).toBe('string');
    });

    // === File content commands ===

    test('cat command returns file content', async () => {
        await buildGraph(repo, [
            { label: 'v1', description: 'v1', files: { 'file.txt': 'version 1' } },
            { parents: ['v1'], files: { 'file.txt': 'version 2' }, isCurrentWorkingCopy: true },
        ]);

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

        await jjService.squashRevision({ paths: [filePath1], revision: '@-', intoRevision: '@' });

        expect(repo.getFileContent('@-', file1).trim()).toBe('base1');
        expect(repo.getFileContent('@', file1)).toBe('modified1 in parent');

        expect(repo.getFileContent('@-', file2)).toBe('modified2 in parent');
        expect(repo.getFileContent('@', file2)).toBe('modified2 in parent');
    }, 30000);

    test('getWorkingCopyChanges detects renamed file', async () => {
        const oldFile = 'old-rename.txt';
        const newFile = 'new-rename.txt';
        const content = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10);

        repo.writeFile(oldFile, content);
        repo.describe('parent');

        await jjService.new();

        repo.moveFile(oldFile, newFile);

        const changes = await jjService.getWorkingCopyChanges();

        expect(changes.length).toBe(1);
        expect(changes[0].status).toBe('renamed');
        expect(changes[0].path).toBe(newFile);
        expect(changes[0].oldPath).toBe(oldFile);
    });
});
