/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

import {
    type CommitDetailsHostToWebviewMessage,
    CommitDetailsHostToWebviewMessageSchema,
    CommitDetailsToHostMessageSchema,
} from '../core/host/ipc/commit-details-schemas';
import type { RpcReceiverHandlers } from '../core/host/webview-rpc-dispatcher';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { createCommitDetailsUri, Uri } from '../core/uri-utils';
import {
    JjCommitDocument,
    VsCodeCommitDetailsEditorProvider,
} from '../vscode/providers/vscode-commit-details-editor-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

function createClient(handlers?: Partial<RpcReceiverHandlers<CommitDetailsHostToWebviewMessage, 'type'>>) {
    return createMockWebviewClient({
        toHostSchema: CommitDetailsToHostMessageSchema,
        hostToWebviewSchema: CommitDetailsHostToWebviewMessageSchema,
        handlers,
    });
}

describe('VsCodeCommitDetailsEditorProvider save', () => {
    let testRepo: TestRepo;
    let repositoryManager: JjRepositoryManager;
    let fakeHost: FakeHostEnvironment;
    let provider: VsCodeCommitDetailsEditorProvider;

    beforeEach(async () => {
        vi.clearAllMocks();
        testRepo = new TestRepo();
        testRepo.init();
        testRepo.writeFile('file.txt', 'initial content\n');
        testRepo.describe('initial commit');

        fakeHost = new FakeHostEnvironment();
        fakeHost.workspace.addFolder(Uri.file(testRepo.path));

        const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });
        repositoryManager = new JjRepositoryManager(outputChannel, fakeHost);
        await repositoryManager.maybeRegisterRepositoryContainingUri(Uri.file(testRepo.path));

        provider = new VsCodeCommitDetailsEditorProvider(
            Uri.file('/extension/path'),
            repositoryManager,
            createMock<vscode.ExtensionContext>({ subscriptions: [] }),
        );
    });

    afterEach(async () => {
        provider.dispose();
        await repositoryManager.dispose();
        testRepo.dispose();
    });

    test('saveCustomDocument persists commit description to real repository', async () => {
        const changeId = testRepo.getChangeId('@');
        const repoRoot = Uri.file(testRepo.path);
        const docUri = createCommitDetailsUri({
            repoRoot: testRepo.path,
            changeId,
            title: `Commit: ${changeId}`,
        });
        const document = new JjCommitDocument(docUri, changeId, repoRoot);
        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        const client = createClient();
        await provider.resolveCustomEditor(document, client.panel, cancellationToken);
        await client.sender.webviewLoaded();

        const controller = provider.getController(changeId, repoRoot);
        expect(controller).toBeDefined();

        controller?.updateDraft('saved through saveCustomDocument');
        await provider.saveCustomDocument(document, cancellationToken);

        expect(controller?.draftDescription).toBe('saved through saveCustomDocument');
        expect(controller?.persistedDescription).toBe('saved through saveCustomDocument');
        expect(testRepo.log()).toContain('saved through saveCustomDocument');

        client.dispose();
    });

    test('saveCustomDocument preserves in-flight edits made while saving and fires onDidChangeCustomDocument', async () => {
        const changeId = testRepo.getChangeId('@');
        const repoRoot = Uri.file(testRepo.path);
        const docUri = createCommitDetailsUri({
            repoRoot: testRepo.path,
            changeId,
            title: `Commit: ${changeId}`,
        });
        const document = new JjCommitDocument(docUri, changeId, repoRoot);
        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        const client = createClient();
        await provider.resolveCustomEditor(document, client.panel, cancellationToken);
        await client.sender.webviewLoaded();

        const controller = provider.getController(changeId, repoRoot);
        expect(controller).toBeDefined();

        const editListener = vi.fn();
        const sub = provider.onDidChangeCustomDocument(editListener);

        controller?.updateDraft('first draft');

        const savePromise = provider.saveCustomDocument(document, cancellationToken);
        await client.sender.descriptionChanged({
            description: 'first draft + concurrent typing',
        });
        await savePromise;

        expect(controller?.draftDescription).toBe('first draft + concurrent typing');
        expect(controller?.persistedDescription).toBe('first draft');
        expect(testRepo.log()).toContain('first draft');

        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });

        expect(editListener).toHaveBeenCalledWith(
            expect.objectContaining({
                document,
                label: 'Edit Description',
            }),
        );

        sub.dispose();
        client.dispose();
    });

    test('concurrent saveCustomDocument calls are serialized safely without collisions', async () => {
        const changeId = testRepo.getChangeId('@');
        const repoRoot = Uri.file(testRepo.path);
        const docUri = createCommitDetailsUri({
            repoRoot: testRepo.path,
            changeId,
            title: `Commit: ${changeId}`,
        });
        const document = new JjCommitDocument(docUri, changeId, repoRoot);
        const cancellationToken = createMock<vscode.CancellationToken>({
            isCancellationRequested: false,
        });

        const client = createClient();
        await provider.resolveCustomEditor(document, client.panel, cancellationToken);
        await client.sender.webviewLoaded();

        const controller = provider.getController(changeId, repoRoot);
        expect(controller).toBeDefined();

        controller?.updateDraft('step 1');
        const p1 = provider.saveCustomDocument(document, cancellationToken);

        controller?.updateDraft('step 2');
        const p2 = provider.saveCustomDocument(document, cancellationToken);

        await Promise.all([p1, p2]);

        expect(controller?.draftDescription).toBe('step 2');
        expect(controller?.persistedDescription).toBe('step 2');
        expect(testRepo.log()).toContain('step 2');

        client.dispose();
    });
});
