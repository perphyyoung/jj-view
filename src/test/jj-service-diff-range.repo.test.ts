/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

/**
 * Parity guard: real jj output must parse into the same field shape the fixture
 * unit tests validate. Field-level assertions live in `jj-changes-fields.test.ts`.
 */
describe('JjService getChangesBetween parity', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('real jj output parses into valid JjFileChange fields for revision range diff', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: {
                    'shared.txt': 'root shared\n',
                    'common.txt': 'root common\n',
                    'deleted_in_merge.txt': 'to be deleted\n',
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
                files: { 'common.txt': 'featureB common\n', 'feature_b.txt': 'added in B\n' },
            },
            {
                label: 'featureB2',
                parents: ['featureB'],
                files: { 'feature_b.txt': 'added in B2\n' },
            },
            {
                label: 'merge',
                parents: ['featureA2', 'featureB2'],
                files: { 'common.txt': 'resolved common\n' },
            },
        ]);

        repo.edit(ids.featureA2.changeId);
        repo.deleteFile('deleted_in_merge.txt');

        const changes = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);
        changes.sort((a, b) => a.path.localeCompare(b.path));

        // Required fields
        expect(changes.length).toBeGreaterThan(0);

        const deleted = changes.find((c) => c.path === 'deleted_in_merge.txt');
        expect(deleted).toBeDefined();
        expect(deleted?.status).toBe('deleted');

        const added = changes.find((c) => c.path === 'feature_a.txt');
        expect(added).toBeDefined();
        expect(added?.status).toBe('added');

        const modified = changes.find((c) => c.path === 'common.txt');
        expect(modified).toBeDefined();
        expect(modified?.status).toBe('modified');
    });
});
