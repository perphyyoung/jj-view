/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService rebase', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('rebase command supports source and revision modes with children', async () => {
        // Setup: Root -> Target
        //       -> Grandparent -> Parent -> Child
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'target', parents: ['root'], description: 'target' },
            { label: 'grandparent', parents: ['root'], description: 'grandparent' },
            { label: 'parent', parents: ['grandparent'], description: 'parent' },
            { label: 'child', parents: ['parent'], description: 'child', isCurrentWorkingCopy: true },
        ]);
        const rootId = ids.root.changeId;
        const targetId = ids.target.changeId;
        const grantparentId = ids.grandparent.changeId;
        const parentId = ids.parent.changeId;
        const childId = ids.child.changeId;

        // 1. Rebase -r check (Revision Mode)
        // Scenario: Move "Parent" (-r) to "Target". Child should stay on Grandparent.

        await jjService.rebase(parentId, { target: targetId, mode: 'revision' });

        const [parentLog] = await jjService.getLog({ revision: parentId });
        const [targetLog] = await jjService.getLog({ revision: targetId });
        const [childLog] = await jjService.getLog({ revision: childId });
        const [grandparentLog] = await jjService.getLog({ revision: grantparentId });

        // Parent is child of Target
        expect(parentLog.parents[0].commit_id).toBe(targetLog.commit_id);

        // Child is NOW child of Grandparent (orphaned from moved Parent)
        expect(childLog.parents[0].commit_id).toBe(grandparentLog.commit_id);

        // 2. Rebase -s check (Source Mode)
        // Scenario: Move Grandparent (-s) to Root. Child should follow.

        await jjService.rebase(grantparentId, { target: rootId, mode: 'source' });

        const [grandparentLogAfter] = await jjService.getLog({ revision: grantparentId });
        const [childLogAfter] = await jjService.getLog({ revision: childId });
        const [rootLog] = await jjService.getLog({ revision: rootId });

        // Grandparent is child of Root
        expect(grandparentLogAfter.parents[0].commit_id).toBe(rootLog.commit_id);

        // Child is child of Grandparent
        expect(childLogAfter.parents[0].commit_id).toBe(grandparentLogAfter.commit_id);
    });

    test('rebase command supports insertAfter and insertBefore in revision and branch modes', async () => {
        // Setup: Root -> A -> B -> C -> D
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'commit A' },
            { label: 'b', parents: ['a'], description: 'commit B' },
            { label: 'c', parents: ['b'], description: 'commit C' },
            { label: 'd', parents: ['c'], description: 'commit D' },
        ]);

        // Scenario 1: Rebase revision C insertAfter A -> DAG becomes root -> A -> C -> B -> D
        await jjService.rebase(ids.c.changeId, { target: ids.a.changeId, placement: 'after', mode: 'revision' });

        const [cLog] = await jjService.getLog({ revision: ids.c.changeId });
        const [bLog] = await jjService.getLog({ revision: ids.b.changeId });
        const [dLog] = await jjService.getLog({ revision: ids.d.changeId });
        const [aLog] = await jjService.getLog({ revision: ids.a.changeId });

        expect(cLog.parents).toHaveLength(1);
        expect(cLog.parents[0].commit_id).toBe(aLog.commit_id);
        expect(bLog.parents).toHaveLength(1);
        expect(bLog.parents[0].commit_id).toBe(cLog.commit_id);
        expect(dLog.parents).toHaveLength(1);
        expect(dLog.parents[0].commit_id).toBe(bLog.commit_id);

        // Scenario 2: Rebase revision C insertBefore D -> DAG becomes root -> A -> B -> C -> D
        await jjService.rebase(ids.c.changeId, { target: ids.d.changeId, placement: 'before', mode: 'revision' });

        const [cLog2] = await jjService.getLog({ revision: ids.c.changeId });
        const [bLog2] = await jjService.getLog({ revision: ids.b.changeId });
        const [dLog2] = await jjService.getLog({ revision: ids.d.changeId });

        expect(bLog2.parents).toHaveLength(1);
        expect(bLog2.parents[0].commit_id).toBe(aLog.commit_id);
        expect(cLog2.parents).toHaveLength(1);
        expect(cLog2.parents[0].commit_id).toBe(bLog2.commit_id);
        expect(dLog2.parents).toHaveLength(1);
        expect(dLog2.parents[0].commit_id).toBe(cLog2.commit_id);

        // Scenario 3: Branch mode (mode: 'source') with insertAfter and insertBefore
        // Setup separate branch: Root -> BranchHead -> BranchChild
        const branchIds = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'branch_head', parents: ['root'], description: 'Branch Head' },
            { label: 'branch_child', parents: ['branch_head'], description: 'Branch Child' },
        ]);

        // Insert branch (branch_head + branch_child) after A in root -> A -> B -> C -> D
        await jjService.rebase(branchIds.branch_head.changeId, {
            target: ids.a.changeId,
            placement: 'after',
            mode: 'source',
        });

        const [rebasedBranchHead] = await jjService.getLog({ revision: branchIds.branch_head.changeId });
        const [rebasedBranchChild] = await jjService.getLog({ revision: branchIds.branch_child.changeId });

        expect(rebasedBranchHead.parents).toHaveLength(1);
        expect(rebasedBranchHead.parents[0].commit_id).toBe(aLog.commit_id);
        expect(rebasedBranchChild.parents).toHaveLength(1);
        expect(rebasedBranchChild.parents[0].commit_id).toBe(rebasedBranchHead.commit_id);

        // Setup another branch for insertBefore: Root -> BranchHead2 -> BranchChild2
        const branchIds2 = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'branch_head_2', parents: ['root'], description: 'Branch Head 2' },
            { label: 'branch_child_2', parents: ['branch_head_2'], description: 'Branch Child 2' },
        ]);

        // Insert branch (branch_head_2 + branch_child_2) before D
        await jjService.rebase(branchIds2.branch_head_2.changeId, {
            target: ids.d.changeId,
            placement: 'before',
            mode: 'source',
        });

        const [rebasedHead2] = await jjService.getLog({ revision: branchIds2.branch_head_2.changeId });
        const [rebasedChild2] = await jjService.getLog({ revision: branchIds2.branch_child_2.changeId });
        const [targetDLog] = await jjService.getLog({ revision: ids.d.changeId });

        expect(rebasedHead2.parents).toHaveLength(1);
        expect(rebasedChild2.parents).toHaveLength(1);
        expect(rebasedChild2.parents[0].commit_id).toBe(rebasedHead2.commit_id);
        expect(targetDLog.parents).toHaveLength(1);
        expect(targetDLog.parents[0].commit_id).toBe(rebasedChild2.commit_id);
    });

    test('rebase rejects empty target, empty source, and self-rebase', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'a', parents: ['root'], description: 'commit A' },
            { label: 'b', parents: ['a'], description: 'commit B' },
        ]);

        await expect(jjService.rebase('', { target: ids.a.changeId })).rejects.toThrow(
            'Rebase source must not be empty',
        );
        await expect(jjService.rebase('   ', { target: ids.a.changeId })).rejects.toThrow(
            'Rebase source must not be empty',
        );
        await expect(jjService.rebase(ids.a.changeId, { target: '' })).rejects.toThrow(
            'Rebase target must not be empty',
        );
        await expect(jjService.rebase(ids.a.changeId, { target: [] })).rejects.toThrow(
            'Rebase target must not be empty',
        );
        await expect(jjService.rebase(ids.a.changeId, { target: ['  '] })).rejects.toThrow(
            'Rebase target must not be empty',
        );
        await expect(jjService.rebase(ids.a.changeId, { target: ids.a.changeId })).rejects.toThrow(
            'Cannot rebase a revision onto or around itself',
        );
        await expect(jjService.rebase(`  ${ids.a.changeId}  `, { target: ids.a.changeId })).rejects.toThrow(
            'Cannot rebase a revision onto or around itself',
        );

        // Deduplicates identical targets gracefully
        await expect(
            jjService.rebase(ids.b.changeId, { target: [ids.a.changeId, `  ${ids.a.changeId}  `], mode: 'revision' }),
        ).resolves.toBeDefined();
    });
});
