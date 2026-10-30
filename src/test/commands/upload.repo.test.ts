/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    buildStackPushArgs,
    isEligibleForAutoStackedUpload,
    resolveStackCommits,
    resolveStackedUploadCommand,
    uploadCommand,
    uploadStackCommand,
} from '../../core/commands/upload';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import type { JjBookmark, JjLogEntry } from '../../core/jj-types';
import { createUploadPayload, createUploadStackPayload } from '../../vscode/payloads/upload.payload';
import { FakeCommandContext } from '../fake-host-environment';
import { buildGraph, TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('uploadCommand', () => {
    let jjService: JjService;
    let repo: TestRepo;
    let remoteRepos: TestRepo[] = [];
    let mockJjRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        remoteRepos = [];
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);

        mockJjRepo = createMock<JjRepository>({
            jj: jjService,
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    afterEach(async () => {
        await repo.dispose();
        for (const r of remoteRepos) {
            await r.dispose();
        }
        remoteRepos = [];
        vi.clearAllMocks();
    });

    async function setupRemote() {
        const remoteRepo = new TestRepo();
        remoteRepo.init();
        remoteRepos.push(remoteRepo);
        repo.addRemote('origin', remoteRepo.path);
        repo.config('remotes.origin.auto-track-bookmarks', '"*"');
        repo.config('git.push', '"origin"');
        return remoteRepo;
    }

    test('uses custom upload command when configured (correctly)', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test custom upload', bookmarks: ['feature-x'] },
            { label: 'commitB', parents: ['commitA'], description: 'test custom upload 2', isCurrentWorkingCopy: true },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        // Setup config to return 'git push' ONLY when queried for 'uploadCommand'
        ctx.host.config.set('uploadCommand', 'git push');

        await uploadCommand(ctx, { revision: 'feature-x' });

        // Verify that the push succeeded and remote repository now has the ref
        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });

    test('falls back to default when custom command is empty', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test default upload', bookmarks: ['feature-x'] },
            {
                label: 'commitB',
                parents: ['commitA'],
                description: 'test default upload 2',
                isCurrentWorkingCopy: true,
            },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        await uploadCommand(ctx, { revision: 'feature-x' });

        // Verify that the default push succeeded
        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
        expect(mockJjRepo.refresh).toHaveBeenCalled();
    });

    test('extracts revision from object payload (repro for r.substring error)', async () => {
        repo.describe('root commit');
        const ids = await buildGraph(repo, [
            { label: 'commitA', description: 'test object payload', bookmarks: ['feature-x'] },
            {
                label: 'commitB',
                parents: ['commitA'],
                description: 'test object payload 2',
                isCurrentWorkingCopy: true,
            },
        ]);

        const remoteRepo = await setupRemote();

        // Push first to make it tracked
        repo.gitPush('feature-x');
        repo.bookmarkMove('feature-x', ids.commitB.changeId);

        await uploadCommand(ctx, { revision: 'feature-x' });

        expect(remoteRepo.hasGitRef('refs/heads/feature-x')).toBe(true);
    });

    test('suggests configuration when upload fails and no custom command set', async () => {
        repo.describe('root commit');
        await buildGraph(repo, [
            {
                label: 'commitA',
                description: 'test failing upload',
                bookmarks: ['feature-x'],
                isCurrentWorkingCopy: true,
            },
        ]);

        ctx.host.ui.setNextErrorResponse('Configure Upload...');

        await uploadCommand(ctx, { revision: 'feature-x' });

        expect(ctx.host.ui.errorMessages[0]).toContain('Upload failed');
        expect(ctx.host.nav.settingsOpened).toContain('jj-view.uploadCommand');
    });

    test('does not suggest configuration when custom command is already set', async () => {
        repo.describe('root commit');
        await buildGraph(repo, [
            {
                label: 'commitA',
                description: 'test failed custom upload',
                bookmarks: ['feature-x'],
                isCurrentWorkingCopy: true,
            },
        ]);

        // Use an invalid custom command that will fail
        ctx.host.config.set('uploadCommand', 'git push-nonexistent');

        ctx.host.ui.setNextErrorResponse('Show Log');

        await uploadCommand(ctx, { revision: 'feature-x' });

        expect(ctx.host.ui.errorMessages[0]).toContain('Upload failed');
        expect(ctx.host.nav.settingsOpened).toHaveLength(0);
    });

    describe('stacked upload support', () => {
        async function setupRemoteWithBase() {
            const remoteRepo = new TestRepo();
            remoteRepo.init();
            remoteRepos.push(remoteRepo);
            repo.addRemote('origin', remoteRepo.path);
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');
            repo.config('git.push', '"origin"');

            // Initialize base branch on origin so commits on top of it have an immutable base
            repo.describe('base commit');
            repo.bookmark('base', '@');
            repo.gitPush('base');
            repo.config('revset-aliases."trunk()"', '"base@origin"');
            return remoteRepo;
        }

        test('resolveStackCommits returns commits in topological order (root to tip)', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['bm-a'] },
                { label: 'commitB', parents: ['commitA'], description: 'commit B', bookmarks: ['bm-b'] },
                { label: 'commitC', parents: ['commitB'], description: 'commit C', bookmarks: ['bm-c'] },
            ]);

            const stack = await resolveStackCommits(jjService, ids.commitC.changeId);
            expect(stack.length).toBe(3);
            expect(stack[0].change_id).toBe(ids.commitA.changeId);
            expect(stack[1].change_id).toBe(ids.commitB.changeId);
            expect(stack[2].change_id).toBe(ids.commitC.changeId);
        });

        test('isEligibleForAutoStackedUpload requires multiple commits and all to have local bookmarks', () => {
            const makeCommit = (
                commitId: string,
                parentIds: string[],
                bookmarks?: Array<{ name: string; remote?: string }>,
            ) =>
                createMock<JjLogEntry>({
                    commit_id: commitId,
                    parents: parentIds.map((pid) => ({ commit_id: pid, change_id: pid, is_immutable: false })),
                    bookmarks: bookmarks?.map((b) => createMock<JjBookmark>({ name: b.name, remote: b.remote })),
                });

            // Single commit
            expect(isEligibleForAutoStackedUpload([makeCommit('c1', ['root'], [{ name: 'b1' }])])).toBe(false);

            // Multiple commits, linear chain, all have local bookmarks
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], [{ name: 'b2' }]),
                ]),
            ).toBe(true);

            // Multiple commits, non-linear chain (merge / wrong parent)
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['other'], [{ name: 'b2' }]),
                ]),
            ).toBe(false);

            // Multiple commits, one has only remote bookmark
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], [{ name: 'b2', remote: 'origin' }]),
                ]),
            ).toBe(false);

            // Multiple commits, one has no bookmarks
            expect(
                isEligibleForAutoStackedUpload([
                    makeCommit('c1', ['root'], [{ name: 'b1' }]),
                    makeCommit('c2', ['c1'], []),
                ]),
            ).toBe(false);
        });

        test('buildStackPushArgs generates -r for bookmarked commits and -c for unbookmarked', () => {
            const commitA = createMock<JjLogEntry>({
                change_id: 'ch-a',
                bookmarks: [createMock<JjBookmark>({ name: 'bm-a' })],
            });
            const commitB = createMock<JjLogEntry>({
                change_id: 'ch-b',
                bookmarks: [],
            });
            const commitC = createMock<JjLogEntry>({
                change_id: 'ch-c',
                bookmarks: [createMock<JjBookmark>({ name: 'bm-c' })],
            });

            const args = buildStackPushArgs([commitA, commitB, commitC]);
            expect(args).toEqual(['-r', 'bm-a', '-c', 'ch-b', '-r', 'bm-c']);
        });

        test('auto-detects stacked upload when all commits in revset have bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'stacked commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'stacked commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId });

            // Both bookmarks should have been pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
        });

        test('auto-detect falls back to single-commit upload when an intermediate commit lacks a bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'unbookmarked commit A' },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'bookmarked commit B',
                    bookmarks: ['tip-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId });

            // Only tip-b is pushed; no push- bookmark generated for commitA
            expect(remoteRepo.hasGitRef('refs/heads/tip-b')).toBe(true);
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(0);
        });

        test('explicit uploadStackCommand pushes entire stack creating bookmarks for unbookmarked commits', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'unbookmarked commit A' },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'bookmarked commit B',
                    bookmarks: ['tip-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            // Both tip-b and auto-generated push bookmark for commitA are pushed
            expect(remoteRepo.hasGitRef('refs/heads/tip-b')).toBe(true);
            const pushRefs = remoteRepo.listGitRefs('refs/heads/push-');
            expect(pushRefs.length).toBe(1);
        });

        test('explicit mode: single pushes only targeted commit even when all stack commits have bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'single' });

            // Only stack-b is pushed; stack-a is not pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(false);
        });

        test('delegates to uploadStackCommand when alwaysUploadStack is enabled, even with mode single', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'stacked commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'stacked commit B',
                    bookmarks: ['stack-b'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            ctx.host.config.set('alwaysUploadStack', true);

            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'single' });

            // Both bookmarks in the stack should have been uploaded to remote
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
        });

        test('uploading a commit partway up a stack pushes only that commit and its ancestors, not its children', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (root)',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle - target)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child / descendant)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            // Upload stack targeting the middle commit (commitB)
            await uploadStackCommand(ctx, { revision: ids.commitB.changeId });

            // Ancestor (commitA) and target (commitB) must be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);

            // Child/descendant (commitC) must NOT be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('auto-detect upload on middle commit pushes ancestors and target commit, excluding children', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            // Call uploadCommand with mode: 'auto' on commitB
            await uploadCommand(ctx, { revision: ids.commitB.changeId, mode: 'auto' });

            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('upload stack on middle commit does not push child even when child bookmark is tracked', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                },
            ]);

            // Push stack-c so it is tracked on origin
            repo.gitPush('stack-c');
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(true);
            const initialChildSha = remoteRepo.getGitRefSha('refs/heads/stack-c');

            // Now mutate commitC so local bookmark has new changes that could be pushed
            repo.new([ids.commitC.changeId], 'commit C updated');
            repo.bookmarkMove('stack-c', '@');

            // User right-clicks commitB and triggers Upload Stack via payload
            const payload = createUploadStackPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadStackCommand(ctx, payload);

            // stack-a and stack-b should be pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);

            // stack-c should NOT have been updated on remote
            const finalChildSha = remoteRepo.getGitRefSha('refs/heads/stack-c');
            expect(finalChildSha).toBe(initialChildSha);
        });

        test('upload via context menu payload defaults to single commit and excludes other bookmarks', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A',
                    bookmarks: ['stack-a'],
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadCommand(ctx, payload);

            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            expect(remoteRepo.hasGitRef('refs/heads/stack-a')).toBe(false);
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('auto-detect falls back to single-commit upload when ancestor lacks bookmark, without uploading child with bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (unbookmarked)',
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadCommand(ctx, payload);

            // Single upload on commitB pushes stack-b only
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            // Neither unbookmarked ancestor commitA nor child commitC are pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('explicit uploadStackCommand pushes ancestor and target, excluding child with bookmark even when ancestor lacks bookmark', async () => {
            const remoteRepo = await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                {
                    label: 'commitA',
                    parents: ['base'],
                    description: 'commit A (unbookmarked)',
                },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B (middle)',
                    bookmarks: ['stack-b'],
                },
                {
                    label: 'commitC',
                    parents: ['commitB'],
                    description: 'commit C (child)',
                    bookmarks: ['stack-c'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            const payload = createUploadStackPayload([
                { webviewSection: 'commit', commitId: ids.commitB.commitId, changeId: ids.commitB.changeId },
            ]);

            await uploadStackCommand(ctx, payload);

            // commitA is pushed with an auto-generated bookmark
            const remoteRefs = remoteRepo.listGitRefs('refs/heads/');
            expect(remoteRefs.some((r) => r.includes('push-'))).toBe(true);
            // commitB is pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-b')).toBe(true);
            // Child commitC is NOT pushed
            expect(remoteRepo.hasGitRef('refs/heads/stack-c')).toBe(false);
        });

        test('empty working copy @ falls back to @- when target is specified by change ID', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'commit B',
                    bookmarks: ['stack-b'],
                },
            ]);
            // Create an empty working copy on top of commitB
            repo.new([ids.commitB.changeId], '');
            const currentEntries = await jjService.getLog({ revision: '@' });
            const workingCopyChangeId = currentEntries[0].change_id;

            // Pass the working copy changeId as target revision
            const stack = await resolveStackCommits(jjService, workingCopyChangeId);
            expect(stack.length).toBe(2);
            expect(stack[0].change_id).toBe(ids.commitA.changeId);
            expect(stack[1].change_id).toBe(ids.commitB.changeId);
        });

        test('resolveStackedUploadCommand throws error on non-linear stack', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['stack-a'] },
                { label: 'commitB', parents: ['base'], description: 'commit B', bookmarks: ['stack-b'] },
                {
                    label: 'commitM',
                    parents: ['commitA', 'commitB'],
                    description: 'merge commit',
                    bookmarks: ['stack-m'],
                    isCurrentWorkingCopy: true,
                },
            ]);

            await expect(resolveStackedUploadCommand(mockJjRepo, ids.commitM.changeId)).rejects.toThrow(
                'Stacked upload requires a linear sequence of commits',
            );
        });

        test('resolveStackedUploadCommand appends stack args to custom uploadCommand', async () => {
            await setupRemoteWithBase();
            const ids = await buildGraph(repo, [
                { label: 'commitA', parents: ['base'], description: 'commit A', bookmarks: ['bm-a'] },
                { label: 'commitB', parents: ['commitA'], description: 'commit B', bookmarks: ['bm-b'] },
            ]);

            const resolved = await resolveStackedUploadCommand(
                mockJjRepo,
                ids.commitB.changeId,
                'git push --force-with-lease',
            );
            expect(resolved.subcommand).toBe('git');
            expect(resolved.commandArgs).toEqual(['push', '--force-with-lease', '-r', 'bm-a', '-r', 'bm-b']);
        });

        test('custom uploadCommand uploads working copy when revision argument is undefined', async () => {
            repo.describe('root commit');
            const ids = await buildGraph(repo, [
                { label: 'commitA', description: 'test custom upload undefined rev', bookmarks: ['feature-def'] },
                {
                    label: 'commitB',
                    parents: ['commitA'],
                    description: 'test custom upload undefined rev 2',
                    isCurrentWorkingCopy: true,
                },
            ]);

            const remoteRepo = await setupRemote();

            repo.gitPush('feature-def');
            repo.bookmarkMove('feature-def', ids.commitB.changeId);

            ctx.host.config.set('uploadCommand', 'git push');

            await uploadCommand(ctx, undefined);

            expect(remoteRepo.hasGitRef('refs/heads/feature-def')).toBe(true);
            expect(mockJjRepo.refresh).toHaveBeenCalled();
        });

        test('resolveStackedUploadCommand reuses pre-resolved stack commits', async () => {
            const dummyCommits: JjLogEntry[] = [
                createMock<JjLogEntry>({
                    commit_id: 'commit-1',
                    change_id: 'change-1',
                    bookmarks: [{ name: 'bm-1' }],
                    parents: [],
                }),
                createMock<JjLogEntry>({
                    commit_id: 'commit-2',
                    change_id: 'change-2',
                    bookmarks: [{ name: 'bm-2' }],
                    parents: [{ commit_id: 'commit-1', change_id: 'change-1', is_immutable: false }],
                }),
            ];

            const result = await resolveStackedUploadCommand(mockJjRepo, '@', undefined, dummyCommits);
            expect(result.stackCommits).toBe(dummyCommits);
            expect(result.commandArgs).toEqual(['push', '-r', 'bm-1', '-r', 'bm-2']);
        });
    });
});
