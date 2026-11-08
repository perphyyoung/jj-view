/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, ScopedTestRepo, TestRepo } from './test-repo';

describe('JjService getBookmarks', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('getBookmarks returns JjBookmark objects including remote bookmarks', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test bookmark push', bookmarks: ['feature-a', 'feature-b'] },
            {
                label: 'commitB',
                parents: ['commitA'],
                description: 'test local bookmark move',
                isCurrentWorkingCopy: true,
            },
        ]);

        // Setup a remote repo and push a bookmark to it to simulate a remote bookmark
        using remoteRepo = new ScopedTestRepo();
        remoteRepo.init();

        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');

        // Push feature-a to remote
        repo.gitPush('feature-a');

        // Move feature-a locally so it points to a different commit than the remote
        repo.bookmarkMove('feature-a', ids.commitB.changeId);

        // After move, feature-a@origin points to the parent, while local feature-a points to the child.
        // Since their targets differ, feature-a@origin will be returned by getBookmarks().
        const bookmarks = await jjService.getBookmarks();

        expect(bookmarks).toEqual([
            { name: 'feature-a', remote: null },
            { name: 'feature-a', remote: 'origin' },
            { name: 'feature-b', remote: null },
        ]);
    });

    test('getBookmarks with revision filters bookmarks by revision', async () => {
        using remoteRepo = new ScopedTestRepo();
        remoteRepo.init();

        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');

        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'commit A', bookmarks: ['feature-b'] },
            { label: 'commitB', parents: ['commitA'], description: 'commit B', bookmarks: ['feature-c'] },
            { label: 'commitC', parents: ['commitB'], description: 'commit C', bookmarks: ['feature-a'] },
            { label: 'commitD', parents: ['commitC'], description: 'commit D', isCurrentWorkingCopy: true },
        ]);

        // Push feature-b (which is at commitA) to remote
        repo.gitPush('feature-b');

        // Move feature-b locally to commit B
        repo.bookmarkMove('feature-b', ids.commitB.changeId);

        // Push feature-a (which is at commitC) to remote
        repo.gitPush('feature-a');

        // Move feature-a locally to commit D
        repo.bookmarkMove('feature-a', ids.commitD.changeId);

        // Query bookmarks on Commit B (@--)
        const parentBookmarks = await jjService.getBookmarks({ revision: '@--' });
        expect(parentBookmarks).toEqual([
            { name: 'feature-b', remote: null },
            { name: 'feature-b', remote: 'origin' },
            { name: 'feature-c', remote: null },
            { name: 'feature-c', remote: 'origin' },
        ]);

        // Query bookmarks on Commit D (@)
        const childBookmarks = await jjService.getBookmarks({ revision: '@' });
        expect(childBookmarks).toEqual([
            { name: 'feature-a', remote: null },
            { name: 'feature-a', remote: 'origin' },
        ]);
    });
});
