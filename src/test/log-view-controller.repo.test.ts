/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LogViewController } from '../core/controllers/log-view-controller';
import { JjContextKey } from '../core/jj-context-keys';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

/**
 * Real-jj behaviour of the log controller: RPC handling, refreshing from disk and the
 * initial snapshot replay. Pure state lives in `log-view-controller.test.ts` (unit tier).
 */
describe('LogViewController with real jj', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: LogViewController;
    let postedMessages: unknown[];

    beforeEach(async () => {
        vi.clearAllMocks();
        postedMessages = [];
        testRepo = new TestRepo();
        testRepo.init();

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));
        fakeHost.storage.update('jj-view.hiddenCommitActions', ['squash']);

        repositoryManager = new JjRepositoryManager(outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        controller = new LogViewController(repo, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m),
            },
        });
    });

    afterEach(async () => {
        controller.dispose();
        await repositoryManager.dispose();
    });

    test('handles RPC messages via handleMessage', async () => {
        testRepo.writeFile('file.txt', 'hello\n');
        testRepo.describe('initial commit');

        const loadedHandled = await controller.handleMessage({ type: 'webviewLoaded' });
        expect(loadedHandled).toBe(true);

        const selectionHandled = await controller.handleMessage({
            type: 'selectionChange',
            payload: {
                commitIds: ['@'],
                hasImmutableSelection: false,
            },
        });
        expect(selectionHandled).toBe(true);
        expect(controller.selectedCommitIds).toEqual(['@']);
    });

    test('refreshes commits from real repository on disk', async () => {
        testRepo.writeFile('example.txt', 'test content\n');
        testRepo.describe('feature: add example');

        await controller.refresh('test');
        expect(controller.commits.length).toBeGreaterThan(0);
        expect(controller.commits[0].description).toContain('feature: add example');
    });

    test('replays initial snapshot on setMessenger and updates context keys on setCommits', async () => {
        testRepo.writeFile('example.txt', 'test content\n');
        testRepo.describe('feature: add example');
        await controller.refresh('test');

        const newMessages: unknown[] = [];
        controller.setMessenger({
            postMessage: (m) => newMessages.push(m),
        });

        expect(newMessages).toHaveLength(1);
        expect(newMessages[0]).toEqual(
            expect.objectContaining({
                type: 'update',
                payload: expect.objectContaining({
                    commits: expect.any(Array),
                }),
            }),
        );

        // Selection context keys update on setCommits
        const changeId = controller.commits[0].change_id;
        controller.setSelectedCommits([changeId]);
        controller.setCommits(controller.commits);
        expect(fakeHost.commands.contextKeys.get(JjContextKey.SelectionAllowAbandon)).toBe(true);
    });
});
