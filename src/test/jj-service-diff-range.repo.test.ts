/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService getChangesBetween (revision range diff)', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('correctly calculates net changes across complex diamond merge graph', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: {
                    'shared.txt': 'root shared\n',
                    'common.txt': 'root common\n',
                    'deleted_in_merge.txt': 'to be deleted\n',
                    'nested/deep_file.txt': 'original deep\n',
                },
            },
            {
                label: 'featureA',
                parents: ['root'],
                files: { 'common.txt': 'featureA common\n', 'feature_a.txt': 'added in A\n' },
            },
            {
                label: 'featureA2',
                parents: ['featureA'],
                files: { 'shared.txt': 'featureA2 shared\n' },
            },
            {
                label: 'featureB',
                parents: ['root'],
                files: {
                    'common.txt': 'featureB common\n',
                    'feature_b.txt': 'added in B\n',
                    'path with space/file.txt': 'space file\n',
                },
            },
            {
                label: 'featureB2',
                parents: ['featureB'],
                files: { 'path with space/file.txt': 'space file modified\n' },
            },
            {
                label: 'merge',
                parents: ['featureA2', 'featureB2'],
                files: { 'common.txt': 'resolved common\n' },
            },
        ]);

        repo.edit(ids.featureA2.changeId);
        repo.deleteFile('deleted_in_merge.txt');

        // 1. Compare root vs merge across the diamond graph
        const changesVsRoot = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);
        changesVsRoot.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesVsRoot).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'deleted_in_merge.txt', status: 'deleted', conflicted: false },
            { path: 'feature_a.txt', status: 'added', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
            { path: 'shared.txt', status: 'modified', conflicted: false },
        ]);

        // 2. Compare divergent sibling branches (featureA vs featureB2)
        const changesDivergent = await jjService.getChangesBetween(ids.featureA.changeId, ids.featureB2.changeId);
        changesDivergent.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesDivergent).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'feature_a.txt', status: 'deleted', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
        ]);
    });

    test('compares ancestor against multi-level stacked commits leading to @', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                files: { 'file_a.txt': 'a1\n', 'file_b.txt': 'b1\n', 'file_c.txt': 'c1\n', 'dir/file_d.txt': 'd1\n' },
            },
            { label: 'step1', parents: ['base'], files: { 'file_a.txt': 'a2\n', 'step1.txt': 'step1\n' } },
            { label: 'step2', parents: ['step1'], files: { 'dir/file_d.txt': 'd2\n' } },
            { label: 'step3', parents: ['step2'], files: { 'file with spaces in path/data.json': '{"key": "val"}\n' } },
            { label: 'step4', parents: ['step3'], files: { 'step1.txt': 'step1 modified\n', 'file_a.txt': 'a3\n' } },
            { label: 'wc', parents: ['step4'], files: { 'dir/file_d.txt': 'd3\n' } },
        ]);

        repo.edit(ids.step2.changeId);
        repo.deleteFile('file_b.txt');

        repo.edit(ids.wc.changeId);
        repo.deleteFile('file_c.txt');

        const changes = await jjService.getChangesBetween(ids.base.changeId, '@');
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            { path: 'dir/file_d.txt', status: 'modified', conflicted: false },
            { path: 'file with spaces in path/data.json', status: 'added', conflicted: false },
            { path: 'file_a.txt', status: 'modified', conflicted: false },
            { path: 'file_b.txt', status: 'deleted', conflicted: false },
            { path: 'file_c.txt', status: 'deleted', conflicted: false },
            { path: 'step1.txt', status: 'added', conflicted: false },
        ]);
    });

    test('correctly detects conflict status across multi-parent merge', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', files: { 'conflict.txt': 'base content\n' } },
            { label: 'branch1', parents: ['root'], files: { 'conflict.txt': 'branch1 content\n' } },
            { label: 'branch2', parents: ['root'], files: { 'conflict.txt': 'branch2 content\n' } },
            { label: 'merge', parents: ['branch1', 'branch2'] },
        ]);

        const changes = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);

        expect(changes).toEqual([
            {
                path: 'conflict.txt',
                status: 'modified',
                conflicted: true,
                conflictSides: 2,
            },
        ]);
    });

    test('returns empty array when comparing identical revisions', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file.txt': 'content\n' } }]);

        const changes = await jjService.getChangesBetween(ids.v1.changeId, ids.v1.changeId);

        expect(changes).toEqual([]);
    });

    test('caches range results and deduplicates concurrent calls', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'a.txt': 'base\n' } },
            { label: 'child', parents: ['base'], files: { 'a.txt': 'child\n' } },
        ]);

        const [changes1, changes2] = await Promise.all([
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1).toEqual([
            {
                path: 'a.txt',
                status: 'modified',
                conflicted: false,
            },
        ]);
    });
});
