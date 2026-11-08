/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CommitDetailsController } from '../core/controllers/commit-details-controller';
import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    type CommitDetailsToHostMessage,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockWebviewClient, type MockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('CommitDetailsController drafts, state and save', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let controller: CommitDetailsController;
    let client: MockWebviewClient<CommitDetailsToHostMessage, CommitDetailsHostToWebviewMessage>;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });

        repositoryManager = new JjRepositoryManager(outputChannel, fakeHost);

        const repo = await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));
        if (!repo) {
            throw new Error('Failed to register repo in test');
        }

        client = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });

        controller = new CommitDetailsController('@', repo, fakeHost);
        controller.addMessenger(client.webview);
    });

    afterEach(async () => {
        client.dispose();
        controller.dispose();
        await repositoryManager.dispose();
        testRepo.dispose();
    });

    test('getInitialPayload preserves active dirty drafts and returns initial state', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        detailsController.updateDraft('unsaved dirty description');

        const payload = await detailsController.getInitialPayload();
        expect(payload).toBeDefined();
        expect(payload?.changeId).toBe(commitId);
        expect(detailsController.draftDescription).toBe('unsaved dirty description');
        expect(payload?.isLoadingFiles).toBe(true);

        detailsController.dispose();
    });

    test('revert dispatches both update and updateDescription messages to reset webview state', async () => {
        testRepo.writeFile('initial.txt', 'initial');
        testRepo.describe('persisted description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('unsaved user edits');
        expect(detailsController.draftDescription).toBe('unsaved user edits');

        detailsController.revert();
        expect(detailsController.draftDescription).toBe('persisted description');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const updateDescMessage = detailsClient.receivedMessages.find((m) => m.type === 'updateDescription');
        expect(updateDescMessage).toEqual({
            type: 'updateDescription',
            payload: {
                description: 'persisted description',
                selectionStart: 0,
                selectionEnd: 0,
            },
        });

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('preserves in-flight edits typed while save is actively executing', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        const detailsClient = createMockWebviewClient({
            toHostSchema: CommitDetailsToHostMessageSchema,
            hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        });
        detailsController.addMessenger(detailsClient.webview);

        await detailsController.load();
        detailsController.updateDraft('version 2 to save');

        const savePromise = detailsController.save();
        detailsController.updateDraft('version 2 to save + concurrent edits');

        const saved = await savePromise;
        expect(saved).toBe(true);

        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save');

        const saveCompleteMsg = detailsClient.receivedMessages.find((m) => m.type === 'saveComplete');
        expect(saveCompleteMsg).toEqual({
            type: 'saveComplete',
            payload: {
                description: 'version 2 to save',
                savedDraft: 'version 2 to save',
            },
        });

        expect(testRepo.log()).toContain('version 2 to save');

        const secondSave = await detailsController.save();
        expect(secondSave).toBe(true);
        expect(detailsController.draftDescription).toBe('version 2 to save + concurrent edits');
        expect(detailsController.persistedDescription).toBe('version 2 to save + concurrent edits');
        expect(testRepo.log()).toContain('version 2 to save + concurrent edits');

        detailsClient.dispose();
        detailsController.dispose();
    });

    test('coalesces concurrent save calls and saves latest draft sequentially', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const detailsController = new CommitDetailsController(commitId, repo, fakeHost);
        await detailsController.load();

        detailsController.updateDraft('draft 1');
        const save1 = detailsController.save();

        detailsController.updateDraft('draft 2');
        const save2 = detailsController.save();

        detailsController.updateDraft('draft 3');
        const save3 = detailsController.save();

        const results = await Promise.all([save1, save2, save3]);
        expect(results).toEqual([true, true, true]);

        expect(detailsController.draftDescription).toBe('draft 3');
        expect(detailsController.persistedDescription).toBe('draft 3');
        expect(testRepo.log()).toContain('draft 3');

        detailsController.dispose();
    });

    test('records edit on host when in-flight edits are present upon save completion', async () => {
        testRepo.writeFile('file.txt', 'data\n');
        testRepo.describe('initial description');
        const commitId = testRepo.getChangeId('@');

        const repo = repositoryManager.repositories[0];
        if (!repo) {
            throw new Error('Expected repository to be registered');
        }

        const editRecordedListener = vi.fn();
        const detailsController = new CommitDetailsController(commitId, repo, fakeHost, {
            onEditRecorded: editRecordedListener,
        });

        await detailsController.load();
        detailsController.updateDraft('first draft to save');

        const savePromise = detailsController.save();
        detailsController.updateDraft('first draft to save + more typing');

        await savePromise;

        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });

        expect(editRecordedListener).toHaveBeenCalled();
        const lastCall = editRecordedListener.mock.calls[editRecordedListener.mock.calls.length - 1];
        expect(lastCall[0]).toEqual(
            expect.objectContaining({
                label: 'Edit Description',
            }),
        );

        detailsController.dispose();
    });
});
