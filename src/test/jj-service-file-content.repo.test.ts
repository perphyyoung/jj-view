/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { TestRepo } from './test-repo';

describe('JjService file content', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('getFileContent returns content at specific revision', async () => {
        repo.writeFile('content-test.txt', 'v1');
        repo.describe('v1');
        const v1ChangeId = repo.getChangeId('@');

        repo.new();
        repo.writeFile('content-test.txt', 'v2');

        const contentV1 = await jjService.getFileContent('content-test.txt', v1ChangeId);
        expect(contentV1).toBe('v1');

        const contentV2 = await jjService.getFileContent('content-test.txt', '@');
        expect(contentV2).toBe('v2');
    });

    test('setFileContent writes content to a specific revision', async () => {
        repo.writeFile('edit-me.txt', 'original content');
        repo.describe('parent');
        const parentId = repo.getChangeId('@');

        // Create a child commit on top
        repo.new();
        repo.writeFile('child-file.txt', 'child');

        // Edit the file in the parent revision
        await jjService.setFileContent(parentId, 'edit-me.txt', 'updated content');

        // Verify the parent revision has the new content
        const parentContent = repo.getFileContent(parentId, 'edit-me.txt');
        expect(parentContent).toBe('updated content');
    });

    test('setFilesContent writes multiple files to a specific revision atomically', async () => {
        const NUM_FILES = 5;
        const files = new Map<string, string>();
        for (let i = 1; i <= NUM_FILES; i++) {
            repo.writeFile(`file${i}.txt`, `old${i}`);
            files.set(`file${i}.txt`, `new${i}`);
        }
        repo.describe('parent');
        const parentId = repo.getChangeId('@');

        repo.new();
        repo.writeFile('child.txt', 'child');

        // Snapshot first to avoid snapshotting operations polluting the count
        repo.snapshot();
        const beforeOpId = repo.getCurrentOperationId();

        await jjService.setFilesContent(parentId, files);

        for (const [filePath, expectedContent] of files) {
            expect(repo.getFileContent(parentId, filePath)).toBe(expectedContent);
        }

        const ops = repo.getOperationsSince(beforeOpId);
        // Verify that the batch write is recorded as a single atomic operation in the op log
        const nonSnapshotOps = ops.filter((op) => !op.description.includes('snapshot'));
        expect(nonSnapshotOps.length).toBe(1);
    });
});
