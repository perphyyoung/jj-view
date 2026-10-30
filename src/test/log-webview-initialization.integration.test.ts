/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { LogViewHostToWebviewMessageSchema, LogViewToHostMessageSchema } from '../core/host/ipc/log-view-schemas';
import { Uri } from '../core/uri-utils';
import { VsCodeLogWebviewProvider } from '../vscode/providers/vscode-log-webview-provider';
import { createTestRepositoryContext } from './integration-test-utils';
import { createMockWebviewClient } from './mock-webview-client';
import { TestRepo } from './test-repo';
import { createMock, createMockLogOutputChannel } from './test-utils';

suite('Log Webview Initialization Integration Test', () => {
    let provider: VsCodeLogWebviewProvider;
    let repo: TestRepo;
    let disposables: vscode.Disposable[] = [];
    let testContext: Awaited<ReturnType<typeof createTestRepositoryContext>>;
    let extensionUri: Uri;
    let outputChannel: ReturnType<typeof createMockLogOutputChannel>;

    setup(async () => {
        repo = new TestRepo();
        await repo.init();

        outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        extensionUri = Uri.file(__dirname);
        testContext = await createTestRepositoryContext(repo.path, outputChannel);
        disposables.push(testContext);

        provider = new VsCodeLogWebviewProvider(
            extensionUri,
            testContext.repository,
            () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            outputChannel,
        );
    });

    teardown(async () => {
        for (const d of disposables) {
            await d.dispose();
        }
        disposables = [];
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('resolveWebviewView sets up webview options and loads script without HTML data injection', async () => {
        // Setup repo with one commit
        repo.new();
        repo.describe('Test Commit 1');

        // 1. Initial Resolve & Refresh
        const client = createMockWebviewClient({
            toHostSchema: LogViewToHostMessageSchema,
            hostToWebviewSchema: LogViewHostToWebviewMessageSchema,
        });
        provider.resolveWebviewView(
            client.view,
            createMock<vscode.WebviewViewResolveContext>({}),
            createMock<vscode.CancellationToken>({}),
        );
        await provider.controller.refresh();

        // 2. Verify HTML is clean and points to webview bundle
        const html = client.webview.html;
        assert.ok(html.includes('dist/webview/index.js'), 'HTML should reference webview bundle');
        assert.ok(!html.includes('window.vscodeInitialData'), 'HTML should not contain initial data script injection');

        client.dispose();
    });

    test('repository getter returns undefined until updateRepository is called', async () => {
        const unattachedProvider = new VsCodeLogWebviewProvider(
            extensionUri,
            /* repo */ undefined,
            /* onSelectionChange */ () => {},
            createMock<vscode.ExtensionContext>({
                globalState: createMock<vscode.ExtensionContext['globalState']>({
                    get: () => [],
                    update: () => Promise.resolve(),
                    setKeysForSync: () => {},
                }),
            }),
            outputChannel,
        );

        assert.strictEqual(unattachedProvider.repository, undefined, 'repository should initially be undefined');

        await unattachedProvider.updateRepository(testContext.repository);
        assert.strictEqual(
            unattachedProvider.repository,
            testContext.repository,
            'repository should be updated after updateRepository call',
        );
    });
});
