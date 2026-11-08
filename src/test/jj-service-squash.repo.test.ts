/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService squash and absorb', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('squash command moves changes to parent', async () => {
        const filePath = path.join(repo.path, 'file.txt');
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { 'file.txt': 'parent content' } },
            { parents: ['parent'], files: { 'file.txt': 'child content' }, isCurrentWorkingCopy: true },
        ]);

        // Squash changes back to parent
        await jjService.squashRevision({ paths: [filePath] });

        // Parent should now have "child content"
        const parentContent = repo.getFileContent('@-', 'file.txt');
        expect(parentContent).toBe('child content');

        // Working copy should be clean (or same as parent)
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toBe('child content');
    });

    test('squash command with revision moves changes to specified parent', async () => {
        // Setup: Root -> Parent -> Child
        const filePath = path.join(repo.path, 'squash-rev.txt');
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { 'squash-rev.txt': 'root' } },
            { label: 'parent', parents: ['root'], description: 'parent', files: { 'squash-rev.txt': 'parent' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'squash-rev.txt': 'child' },
                isCurrentWorkingCopy: true,
            },
        ]);
        const parentId = ids.parent.changeId;
        const childId = ids.child.changeId;

        // Squash "child" revision into "parent" explicitly
        await jjService.squashRevision({ paths: [filePath], revision: childId });

        // Verify parent now has child content
        const parentContent = repo.getFileContent(parentId, 'squash-rev.txt');
        expect(parentContent).toBe('child');
    });

    test('squash command --from --into moves changes between arbitrary commits', async () => {
        // Setup: Root -> A -> B
        const newFileName = 'squash-new.txt';
        const newFilePath = path.join(repo.path, newFileName);

        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'A', parents: ['root'], description: 'A' },
            {
                label: 'B',
                parents: ['A'],
                description: 'B',
                files: { [newFileName]: 'new content' },
                isCurrentWorkingCopy: true,
            },
        ]);
        const rootId = ids.root.changeId;
        const bId = ids.B.changeId;

        // Squash 'new content' from B into Root directly
        await jjService.squashRevision({ paths: [newFilePath], revision: bId, intoRevision: rootId });

        // Root should now have the new file
        const rootContent = repo.getFileContent(rootId, newFileName);
        expect(rootContent).toBe('new content');
    });

    test('squash command --from --onto creates a new commit on top of specified target', async () => {
        // Setup: Root -> A -> B
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'A', parents: ['root'], description: 'A' },
            {
                label: 'B',
                parents: ['root'],
                description: 'B changes',
                files: { 'onto-file.txt': 'onto content' },
            },
        ]);
        const aId = ids.A.changeId;
        const bId = ids.B.changeId;

        // Squash B onto A (creates a new commit with A as parent)
        await jjService.squashRevision({ revision: bId, ontoRevision: aId });

        // Get the newly created commit on top of A
        const children = repo.getChildren(aId);
        expect(children.length).toBeGreaterThan(0);
        const newCommitId = children[0];

        // Verify the file content was preserved in the new commit on top of A
        const newCommitContent = repo.getFileContent(newCommitId, 'onto-file.txt');
        expect(newCommitContent).toBe('onto content');

        // Verify its parent is A
        const parents = repo.getParents(newCommitId);
        expect(parents).toContain(aId);
    });

    test('squashRevision throws error when revision equals intoRevision or ontoRevision', async () => {
        await expect(jjService.squashRevision({ revision: 'rev1', intoRevision: 'rev1' })).rejects.toThrow(
            'Cannot squash revision into or onto itself.',
        );
        await expect(jjService.squashRevision({ revision: 'rev1', ontoRevision: 'rev1' })).rejects.toThrow(
            'Cannot squash revision into or onto itself.',
        );
    });

    test('squashRevision throws error when both intoRevision and ontoRevision are specified', async () => {
        await expect(
            jjService.squashRevision({ revision: 'rev1', intoRevision: 'rev2', ontoRevision: 'rev3' }),
            // jj's wording changed across versions; both phrasings reject the same invalid input.
        ).rejects.toThrow(/Cannot (specify both intoRevision|apply more than one of into)/);
    });

    test('squash without paths squashes entire commit', async () => {
        // Setup: Parent -> Child
        await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                files: { 'f1.txt': 'child1', 'f2.txt': 'child2' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // Squash everything into parent
        await jjService.squashRevision();

        const content1 = repo.getFileContent('@-', 'f1.txt');
        const content2 = repo.getFileContent('@-', 'f2.txt');

        expect(content1).toBe('child1');
        expect(content2).toBe('child2');
    });

    test('absorb command moves changes to mutable parent', async () => {
        const fileName = 'absorb.txt';
        await buildGraph(repo, [
            { label: 'parent', description: 'parent', files: { [fileName]: 'line1\nline2\n' } },
            {
                label: 'child',
                parents: ['parent'],
                description: 'child',
                // Modify line 2. jj absorb should figure out it belongs to parent
                files: { [fileName]: 'line1\nline2 modified\n' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // Absorb changes from working copy into parent
        await jjService.absorb();

        // Verify parent has the change
        const parentContent = repo.getFileContent('@-', fileName);
        expect(parentContent).toBe('line1\nline2 modified\n');

        // Verify working copy is clean (same as parent)
        const childContent = repo.readFile(fileName);
        expect(childContent).toBe('line1\nline2 modified\n');
    });

    test('absorb command from specific revision', async () => {
        const fileName = 'absorb-rev.txt';
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root', files: { [fileName]: 'base\n' } },
            {
                label: 'A', // Mutable parent
                parents: ['root'],
                description: 'A',
                files: { [fileName]: 'base\nlineA\n' },
            },
            {
                label: 'B', // Source of change
                parents: ['A'],
                description: 'B',
                files: { [fileName]: 'base\nlineA modified\n' },
            },
            {
                label: 'C', // Working copy
                parents: ['B'],
                description: 'C',
                isCurrentWorkingCopy: true,
            },
        ]);

        // Absorb changes from B into A
        // B modifies lineA which was introduced in A.
        await jjService.absorb({ fromRevision: ids.B.changeId });

        // Verify A has the change
        const contentA = repo.getFileContent(ids.A.changeId, fileName);
        expect(contentA).toBe('base\nlineA modified\n');

        // B should be empty of changes but still exist as it has a description
        const contentB = repo.getFileContent(ids.B.changeId, fileName);
        expect(contentB).toBe('base\nlineA modified\n');
    });
});
