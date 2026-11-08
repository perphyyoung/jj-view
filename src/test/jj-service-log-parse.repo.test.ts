/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService log metadata', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('getLog detects divergent commits and offsets', async () => {
        // 1. Create a commit
        repo.describe('version 1');
        const commitIdV1 = repo.getCommitId('@');

        // 2. Edit the commit message (creates V2)
        repo.describe('version 2');
        const commitIdV2 = repo.getCommitId('@');

        // 3. Bookmark the old commit ID to make it visible
        repo.bookmark('old-version', commitIdV1);

        // Now we have two visible commits for the same change ID: commitIdV1 and commitIdV2
        const logs = await jjService.getLog({ revision: 'all()' });

        const v1Entry = logs.find((l) => l.commit_id === commitIdV1);
        const v2Entry = logs.find((l) => l.commit_id === commitIdV2);

        expect(v1Entry).toBeDefined();
        expect(v2Entry).toBeDefined();

        expect(v1Entry?.is_divergent).toBe(true);
        expect(v2Entry?.is_divergent).toBe(true);

        // Verification of combined change_id
        expect(v1Entry?.change_id).toMatch(/\/\d+$/);
        expect(v2Entry?.change_id).toMatch(/\/\d+$/);

        // In this test setup, V1 gets offset 1 and V2 gets offset 0
        expect(v1Entry?.change_id_offset).toBe(1);
        expect(v2Entry?.change_id_offset).toBe(0);
        expect(v1Entry?.change_id_offset).not.toBe(v2Entry?.change_id_offset);
    });

    test('getLog() includes workspace labels in working_copies field', async () => {
        const workspaceName = 'repo2';

        // Create commits first
        const otherCommit = await buildGraph(repo, [{ label: 'other', description: 'other' }]);
        const otherCommitId = otherCommit.other.changeId;

        // Current workspace 'default' is at 'other'
        const currentWcId = repo.getChangeId('@');

        repo.workspaceAdd(workspaceName, otherCommitId);

        const logs = await jjService.getLog({ revision: 'all()' });

        // The second workspace created a new commit on top of otherCommit
        // Find the commit that has the repo2 workspace label
        const repo2WcEntry = logs.find((l) => l.working_copies?.some((w) => w.startsWith(workspaceName)));

        expect(repo2WcEntry).toBeDefined();
        expect(repo2WcEntry?.is_current_working_copy).toBe(false);

        // Find the commit that is the current working copy
        const currentWcEntry = logs.find((l) => l.is_current_working_copy);
        expect(currentWcEntry).toBeDefined();
        expect(currentWcEntry?.change_id).toBe(currentWcId);
        expect(currentWcEntry?.working_copies).toContain('default');
    });
});
