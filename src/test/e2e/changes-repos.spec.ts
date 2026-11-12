/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { makeTestTmpDir } from '../test-tmp-root';
import { getWebviewFrame, test } from './e2e-helpers';

test.describe('Repositories View E2E', () => {
    test('Sorts repositories from the title-bar command', async ({ vscode }) => {
        const parent = makeTestTmpDir('jj-view-sort-');
        const alpha = new TestRepo(path.join(parent, 'alpha'));
        const beta = new TestRepo(path.join(parent, 'beta'));

        alpha.init();
        alpha.writeFile('a1.txt', 'a1\n');
        alpha.writeFile('a2.txt', 'a2\n');
        beta.init();
        beta.writeFile('b1.txt', 'b1\n');
        beta.describe('beta base');
        beta.new();

        const { page } = await vscode.openWorkspace(
            { path: parent, waitForRepository: false },
            { 'jj-view.detectSubRepositories': true },
        );

        await vscode.executeCommand('jj-view.reposView.focus');
        const frame = await getWebviewFrame(page, 'jj-repos-root');
        const rows = frame.locator('[data-testid="jj-repo-row"]');
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBe(2);

        const header = page.locator('.pane-header', { hasText: 'Repositories' }).first();
        await expect(header).toContainText('Name A→Z', { timeout: 5000 });

        // Two changes in alpha, none in beta.
        await vscode.executeCommand('jj-view.reposSort', 'changeCount');
        await expect(rows.first()).toContainText('alpha');
        await expect(header).toContainText('Changes', { timeout: 5000 });

        await vscode.executeCommand('jj-view.reposSort', 'nameDesc');
        await expect(rows.first()).toContainText('beta');

        // Leave the shared window on the default ordering for the other tests.
        await vscode.executeCommand('jj-view.reposSort', 'name');
        await expect(rows.first()).toContainText('alpha');
    });

    test('Repositories view lists the repository with a change count badge', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');
        repo.writeFile('b.txt', 'b\n');
        repo.describe('initial');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.reposView.focus');
        const frame = await getWebviewFrame(page, 'jj-repos-root');

        await expect(frame.locator('[data-testid="jj-repo-row"]')).toHaveCount(1);
        await expect(frame.locator('[data-testid="jj-repo-row"] .badge').first()).toHaveText('2');
    });

    test('Repositories refresh shows the loading state', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.reposView.focus');
        const frame = await getWebviewFrame(page, 'jj-repos-root');
        await expect(frame.locator('[data-testid="jj-repo-row"]')).toHaveCount(1, { timeout: 5000 });

        await frame.evaluate(() => window.postMessage({ type: 'reloading' }, '*'));
        await expect(frame.locator('[data-testid="jj-repos-loading"]')).toBeVisible({ timeout: 5000 });

        await vscode.executeCommand('jj-view.refreshAll');
        await expect(frame.locator('[data-testid="jj-repo-row"]')).toHaveCount(1, { timeout: 5000 });
        await expect(frame.locator('[data-testid="jj-repos-loading"]')).toHaveCount(0);
    });

    test('Repositories view shows unpushed commit counts', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.reposView.focus');
        const frame = await getWebviewFrame(page, 'jj-repos-root');
        await expect(frame.locator('[data-testid="jj-repo-row"]')).toHaveCount(1, { timeout: 5000 });

        // Inject the state: the badge is a webview contract, and e2e does not need a real remote.
        // No `seq`: an injected high sequence would make the webview drop later real pushes.
        const inject = (unpushedCount: number) =>
            frame.evaluate((count) => {
                window.postMessage(
                    {
                        type: 'state',
                        payload: {
                            repos: [
                                {
                                    root: '/demo',
                                    name: 'demo',
                                    changeCount: 3,
                                    conflictCount: 0,
                                    unpushedCount: count,
                                },
                            ],
                            focusedRoot: undefined,
                            viewMode: 'list',
                            revealChangeIds: [],
                            reposLoading: false,
                        },
                    },
                    '*',
                );
            }, unpushedCount);

        await inject(2);
        await expect(frame.locator('[data-testid="jj-repo-unpushed"]')).toHaveText('↑2', { timeout: 5000 });

        await inject(0);
        await expect(frame.locator('[data-testid="jj-repo-unpushed"]')).toHaveCount(0, { timeout: 5000 });
    });
});
