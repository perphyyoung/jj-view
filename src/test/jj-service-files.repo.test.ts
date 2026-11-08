/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { TestRepo } from './test-repo';

describe('JjService file operations', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    describe('checkTrackedPaths', () => {
        test('returns empty array when given empty paths', async () => {
            const paths = await jjService.checkTrackedPaths([]);
            expect(paths).toEqual([]);
        });

        test('returns only tracked paths', async () => {
            // Setup: 1 tracked file, 1 untracked file
            repo.writeFile('tracked.txt', 'tracked content');
            repo.describe('commit tracked'); // Committing marks it as tracked

            // In jj, files are auto-tracked unless ignored. So to have an untracked file, we ignore it.
            repo.writeFile('.gitignore', 'untracked.txt\n');
            repo.writeFile('untracked.txt', 'untracked content');

            const paths = await jjService.checkTrackedPaths(['tracked.txt', 'untracked.txt']);
            expect(paths).toEqual(['tracked.txt']);
        });

        test('returns all passed paths if jj file list errors', async () => {
            // Pass a path that causes jj file list to error (outside repo)
            const inputPaths = ['../outside.txt'];
            const paths = await jjService.checkTrackedPaths(inputPaths);

            // Should return the exact input paths array
            expect(paths).toEqual(inputPaths);
        });
    });

    test('getGitBlobHashes returns correct blob hashes', async () => {
        const fileName = 'blob.txt';
        const fileContent = 'blob content';

        // Create a file and commit it
        repo.writeFile(fileName, fileContent);
        repo.describe('blob test');
        const commitId = repo.getCommitId('@');

        // Calculate expected Git hash
        // Git blob hash is SHA-1 of "blob <size>\0<content>"
        // For 'blob content', size is 12.
        // echo -n "blob content" | git hash-object --stdin
        // We can use the repo's git command to get the hash of the file content
        const expectedHash = cp
            .execFileSync('git', ['hash-object', path.join(repo.path, fileName)], { cwd: repo.path })
            .toString()
            .trim();

        const hashes = await jjService.getGitBlobHashes(commitId, [fileName]);

        expect(hashes.size).toBe(1);
        expect(hashes.get(fileName)).toBe(expectedHash);

        const cachedHashes = await jjService.getGitBlobHashes(commitId, [fileName]);
        expect(cachedHashes.size).toBe(1);
        expect(cachedHashes.get(fileName)).toBe(expectedHash);
    });

    test('getGitBlobHashes negative-caches missing paths and handles unicode filenames', async () => {
        const unicodeFile = 'café.txt';
        repo.writeFile(unicodeFile, 'unicode content');
        repo.describe('unicode test');
        const commitId = repo.getCommitId('@');

        const expectedHash = cp
            .execFileSync('git', ['hash-object', path.join(repo.path, unicodeFile)], { cwd: repo.path })
            .toString()
            .trim();

        const hashes = await jjService.getGitBlobHashes(commitId, [unicodeFile, 'non-existent.txt']);
        expect(hashes.size).toBe(1);
        expect(hashes.get(unicodeFile)).toBe(expectedHash);
        expect(hashes.has('non-existent.txt')).toBe(false);

        // Repeated query should use cache including negative cache for missing path
        const cachedHashes = await jjService.getGitBlobHashes(commitId, [unicodeFile, 'non-existent.txt']);
        expect(cachedHashes.size).toBe(1);
        expect(cachedHashes.get(unicodeFile)).toBe(expectedHash);
    });
});
