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
describe('JjService getChanges parity', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('real jj output parses into valid JjFileChange fields', async () => {
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

        // Required fields
        expect(changes.length).toBe(3);

        const added = changes.find((c) => c.path === 'added.txt');
        expect(added).toBeDefined();
        expect(added?.status).toBe('added');
        expect(added?.conflicted).toBe(false);

        const modified = changes.find((c) => c.path === 'modified.txt');
        expect(modified).toBeDefined();
        expect(modified?.status).toBe('modified');
        expect(modified?.additions).toBeGreaterThan(0);

        const deleted = changes.find((c) => c.path === 'deleted.txt');
        expect(deleted).toBeDefined();
        expect(deleted?.status).toBe('deleted');
    });
});
