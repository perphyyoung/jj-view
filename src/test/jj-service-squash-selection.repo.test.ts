/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService squash selection', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('squashPartialToParent handles new files (not in parent)', async () => {
        const fileName = 'new-file.txt';
        const filePath = path.join(repo.path, fileName);

        repo.new();

        const content = 'line1\nline2\n';
        repo.writeFile(fileName, content);

        const ranges = [{ startLine: 0, endLine: 1 }];

        await jjService.squashSelectionIntoParent(fileName, ranges);

        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe(content);

        const diskContent = fs.readFileSync(filePath, 'utf8');
        expect(diskContent).toBe(content);

        const diff = await jjService.getDiff('@', fileName);
        expect(diff).toBe('');
    });

    test('squashSelectionIntoParent moves subset of changes', async () => {
        const fileName = 'partial.txt';

        repo.writeFile(fileName, 'line1\nline2\nline3\n');
        repo.describe('parent');
        repo.new();
        // Change line1 -> mod1
        // Change line3 -> mod3
        repo.writeFile(fileName, 'mod1\nline2\nmod3\n');

        // We want to move ONLY 'mod1' to parent.
        // Parent should become: 'mod1\nline2\nline3\n'
        // Child should become: 'mod1\nline2\nmod3\n'

        // Select 'mod1' (line 1, index 0)
        const ranges = [{ startLine: 0, endLine: 0 }];

        await jjService.squashSelectionIntoParent(fileName, ranges);

        // Verify Parent Content
        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('mod1\nline2\nline3\n');

        // Verify Child Content (should remain same)
        const childContent = repo.readFile(fileName);
        expect(childContent).toBe('mod1\nline2\nmod3\n');
    });

    test('squashSelectionIntoParent moves deletion', async () => {
        const fileName = 'deletion.txt';

        // Parent
        repo.writeFile(fileName, 'keep\ndelete\n');
        repo.describe('parent');
        repo.new();

        // Child deletes 'delete'
        repo.writeFile(fileName, 'keep\n');

        // Select the deletion (approximate range covering the area)
        const ranges = [{ startLine: 1, endLine: 2 }];

        await jjService.squashSelectionIntoParent(fileName, ranges);

        // Parent should now have deleted the line
        const parentContent = await jjService.getFileContent(fileName, '@-');
        expect(parentContent).toBe('keep\n');
    });

    test('squashSelectionIntoParent moves selected lines and PRESERVES others in a stack', async () => {
        // Setup: Grandparent -> Parent -> Child
        const ids = await buildGraph(repo, [
            { label: 'grandparent', description: 'grandparent', files: { 'file.txt': 'line 0\n' } },
            {
                label: 'parent',
                parents: ['grandparent'],
                description: 'parent',
                files: { 'file.txt': 'line 0\nline 1\n' },
            },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'file.txt': 'line 0\nline 1\nline 2\nline 3\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        const grandparentId = ids.grandparent.changeId;
        const parentId = ids.parent.changeId;
        const childId = ids.child.changeId;

        // Verify initial state
        const initialChildDiff = await jjService.getDiff(childId, 'file.txt');
        expect(initialChildDiff).toContain('+line 2');
        expect(initialChildDiff).toContain('+line 3');

        // Target: We want to move 'line 2' from Child to Parent, but keep 'line 3' in child.
        await jjService.squashSelectionIntoParent('file.txt', [{ startLine: 2, endLine: 2 }], childId);

        // After move:
        // Parent should have 'line 0\nline 1\nline 2\n'
        const parentContent = await jjService.getFileContent('file.txt', parentId);
        expect(parentContent).toBe('line 0\nline 1\nline 2\n');

        // Child should have 'line 0\nline 1\nline 2\nline 3\n'
        const childContent = await jjService.getFileContent('file.txt', childId);
        expect(childContent).toBe('line 0\nline 1\nline 2\nline 3\n');

        // Child's DIFF should only show '+line 3' (relative to new parent)
        const newChildDiff = await jjService.getDiff(childId, 'file.txt');
        expect(newChildDiff).not.toContain('+line 2');
        expect(newChildDiff).toContain('+line 3');

        // Grandparent should remain UNCHANGED
        const grandparentContent = await jjService.getFileContent('file.txt', grandparentId);
        expect(grandparentContent).toBe('line 0\n');
    });
});
