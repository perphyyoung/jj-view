/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService new command', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('creates a new change with parent', async () => {
        // Create a specific parent to anchor on
        repo.describe('target parent');
        const parentChangeId = repo.getChangeId('@');

        // Move somewhere else first to ensure we are jumping
        repo.new(['root()'], 'unrelated');

        await jjService.new({ parents: [parentChangeId] });

        const parents = repo.getParents('@');
        expect(parents[0]).toBe(parentChangeId);
    });

    test('creates a new change with message and parent', async () => {
        repo.describe('target parent');
        const parentChangeId = repo.getChangeId('@');

        await jjService.new({ message: 'custom message', parents: [parentChangeId] });

        const description = repo.getDescription('@');
        const parents = repo.getParents('@');

        expect(description).toContain('custom message');
        expect(parents[0]).toBe(parentChangeId);
    });

    test('creates change inserted before', async () => {
        // Setup: Parent -> Child
        const ids = await buildGraph(repo, [
            {
                label: 'Parent',
                description: 'Parent',
            },
            {
                label: 'Child',
                parents: ['Parent'],
                description: 'Child',
                isCurrentWorkingCopy: true,
            },
        ]);
        // Insert 'Middle' before 'Child'
        // Expected DAG: Parent -> Middle -> Child
        // Also, 'jj new --before' should move @ to the new commit.
        const middleId = await jjService.new({ message: 'Middle', insertBefore: [ids.Child.changeId] });

        // 1. Verify Middle's parent is Parent
        const middleParents = repo.getParents(middleId);
        expect(middleParents).toContain(ids.Parent.changeId);

        // 2. Verify Child's parent is now Middle
        const childParents = repo.getParents(ids.Child.changeId);
        expect(childParents).toContain(middleId);

        // 3. Verify @ is at Middle
        const workingCopyId = repo.getWorkingCopyId();
        expect(workingCopyId).toBe(middleId);
    });

    test('creates a new change with multiple parents (merge)', async () => {
        // Setup:
        // Parent1
        // Parent2
        const ids = await buildGraph(repo, [
            { label: 'p1', description: 'parent 1' },
            { label: 'p2', description: 'parent 2', isCurrentWorkingCopy: true },
        ]);

        const p1Id = ids.p1.changeId;
        const p2Id = ids.p2.changeId;

        // Create merge commit on top of p1 and p2
        await jjService.new({ message: 'merge commit', parents: [p1Id, p2Id] });

        const description = repo.getDescription('@');
        const parents = repo.getParents('@');

        expect(description).toContain('merge commit');
        expect(parents.length).toBe(2);

        // Verify parent IDs
        expect(parents).toContain(p1Id);
        expect(parents).toContain(p2Id);
    });

    test('creates change inserted before multiple revisions', async () => {
        // Setup: Parent -> Child1
        //               -> Child2
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            { label: 'child2', parents: ['parent'], description: 'child2' },
        ]);

        // Insert 'Middle' before Child1 and Child2
        // Expected DAG: Parent -> Middle -> Child1
        //                            -> Child2
        const middleId = await jjService.new({
            message: 'Middle',
            insertBefore: [ids.child1.changeId, ids.child2.changeId],
        });

        // 1. Verify Middle's parent is Parent
        const middleParents = repo.getParents(middleId);
        expect(middleParents).toContain(ids.parent.changeId);

        // 2. Verify Child1 and Child2 both have Middle as parent
        const c1Parents = repo.getParents(ids.child1.changeId);
        const c2Parents = repo.getParents(ids.child2.changeId);

        expect(c1Parents).toContain(middleId);
        expect(c2Parents).toContain(middleId);

        // 3. Verify @ is at Middle
        const workingCopyId = repo.getWorkingCopyId();
        expect(workingCopyId).toBe(middleId);
    });

    test('creates change inserted after', async () => {
        // Setup: Parent -> Child
        const ids = await buildGraph(repo, [
            { label: 'Parent', description: 'Parent' },
            { label: 'Child', parents: ['Parent'], description: 'Child', isCurrentWorkingCopy: true },
        ]);

        // Insert 'Middle' after 'Parent'
        // Expected DAG: Parent -> Middle -> Child
        const middleId = await jjService.new({ message: 'Middle', insertAfter: [ids.Parent.changeId] });

        // 1. Verify Middle's parent is Parent
        const middleParents = repo.getParents(middleId);
        expect(middleParents).toContain(ids.Parent.changeId);

        // 2. Verify Child's parent is now Middle
        const childParents = repo.getParents(ids.Child.changeId);
        expect(childParents).toContain(middleId);
        // Child no longer has Parent directly
        expect(childParents).not.toContain(ids.Parent.changeId);

        // 3. Verify @ is at Middle
        const workingCopyId = repo.getWorkingCopyId();
        expect(workingCopyId).toBe(middleId);
    });

    test('creates change inserted after multiple revisions', async () => {
        // Setup: P1 -> Child1
        //        P2 -> Child2
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'P1', parents: ['root'], description: 'P1' },
            { label: 'P2', parents: ['root'], description: 'P2' },
            { label: 'Child1', parents: ['P1'], description: 'Child1' },
            { label: 'Child2', parents: ['P2'], description: 'Child2', isCurrentWorkingCopy: true },
        ]);

        // Insert 'Middle' after P1 and P2
        // Expected DAG: P1 -> Middle -> Child1
        //               P2 -/        \-> Child2
        const middleId = await jjService.new({
            message: 'Middle',
            insertAfter: [ids.P1.changeId, ids.P2.changeId],
        });

        // 1. Verify Middle's parents are P1 and P2
        const middleParents = repo.getParents(middleId);
        expect(middleParents).toContain(ids.P1.changeId);
        expect(middleParents).toContain(ids.P2.changeId);

        // 2. Verify Child1 and Child2's parent is now Middle
        const child1Parents = repo.getParents(ids.Child1.changeId);
        expect(child1Parents).toContain(middleId);
        expect(child1Parents).not.toContain(ids.P1.changeId);

        const child2Parents = repo.getParents(ids.Child2.changeId);
        expect(child2Parents).toContain(middleId);
        expect(child2Parents).not.toContain(ids.P2.changeId);
    });
});
