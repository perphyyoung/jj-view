/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService bookmarks', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('moveBookmark moves bookmark to revision', async () => {
        // Setup: Create a bookmark on initial commit
        repo.bookmark('test-bookmark', '@');

        // Create a new commit (child)
        await jjService.new({ message: 'child' });
        const [child] = await jjService.getLog({ revision: '@' });

        // Move bookmark to child
        await jjService.moveBookmark('test-bookmark', child.change_id);

        // Verify bookmark moved
        const [childLog] = await jjService.getLog({ revision: '@' });
        expect(childLog.bookmarks).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'test-bookmark' })]),
        );
    });

    test('advanceBookmark advances all bookmarks to target revision', async () => {
        const ids = await buildGraph(repo, [
            { label: 'initial', description: 'initial' },
            { label: 'child1', parents: ['initial'], description: 'child1' },
            { label: 'child2', parents: ['child1'], description: 'child2' },
        ]);

        repo.bookmark('bookmark-a', ids.initial.changeId);
        repo.bookmark('bookmark-b', ids.initial.changeId);

        // Advance all bookmarks to child2
        await jjService.advanceBookmark(ids.child2.changeId);

        const [child2Log] = await jjService.getLog({ revision: ids.child2.changeId });
        expect(child2Log.bookmarks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'bookmark-a' }),
                expect.objectContaining({ name: 'bookmark-b' }),
            ]),
        );
    });

    test('advanceBookmark advances only specified bookmarks to target revision', async () => {
        const ids = await buildGraph(repo, [
            { label: 'initial', description: 'initial' },
            { label: 'child1', parents: ['initial'], description: 'child1' },
            { label: 'child2', parents: ['child1'], description: 'child2' },
        ]);

        repo.bookmark('bookmark-a', ids.initial.changeId);
        repo.bookmark('bookmark-b', ids.initial.changeId);

        // Advance only bookmark-a to child2
        await jjService.advanceBookmark(ids.child2.changeId, ['bookmark-a']);

        // Verify bookmark-a moved to child2
        const [child2Log] = await jjService.getLog({ revision: ids.child2.changeId });
        expect(child2Log.bookmarks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'bookmark-a' })]));
        expect(child2Log.bookmarks).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ name: 'bookmark-b' })]),
        );

        // Verify bookmark-b remained on initial
        const [initialLog] = await jjService.getLog({ revision: ids.initial.changeId });
        expect(initialLog.bookmarks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'bookmark-b' })]));
    });
});
