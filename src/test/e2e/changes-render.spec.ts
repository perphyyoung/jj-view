/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { getLogWebview, getWebviewFrame, test } from './e2e-helpers';

test.describe('Changes Rendering E2E', () => {
    test('Changes view renders working copy files and toggles tree/list', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('root.txt', 'root\n');
        repo.writeFile('src/a.ts', 'export const a = 1;\n');
        repo.writeFile('src/nested/b.ts', 'export const b = 2;\n');
        repo.describe('initial');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        await expect(frame.locator('.scm-resource-item')).toHaveCount(3);
        await expect(frame.locator('[data-testid="scm-group-working-copy"]')).toBeVisible();

        // Ancestors start collapsed, so only the working copy group contributes file rows.
        await vscode.executeCommand('jj-view.changesAsTree');
        await expect(frame.locator('[data-testid="scm-tree-folder-src"]')).toBeVisible();
        await expect(frame.locator('[data-testid^="scm-tree-folder-"]').first()).toBeVisible();
        await expect(frame.locator('.scm-resource-item')).toHaveCount(3);

        await vscode.executeCommand('jj-view.changesAsList');
        await expect(frame.locator('[data-testid^="scm-tree-folder-"]')).toHaveCount(0);
        await expect(frame.locator('.scm-resource-item')).toHaveCount(3);
    });

    test('Refresh clears the Changes view and reloads it', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('reload.txt', 'reload\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');
        await expect(frame.locator('.scm-resource-item', { hasText: 'reload.txt' })).toBeVisible({ timeout: 5000 });

        // The host's reload notice must clear the list before the new state arrives.
        await frame.evaluate(() => window.postMessage({ type: 'reloading' }, '*'));
        await expect(frame.locator('[data-testid="jj-changes-loading"]')).toBeVisible({ timeout: 5000 });

        await vscode.executeCommand('jj-view.refreshChanges');
        await expect(frame.locator('.scm-resource-item', { hasText: 'reload.txt' })).toBeVisible({ timeout: 5000 });
        await expect(frame.locator('[data-testid="jj-changes-loading"]')).toHaveCount(0);
    });

    test('container works without native SCM integration', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');
        repo.describe('initial');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');
        await expect(frame.locator('.scm-resource-item')).toHaveCount(1);
    });

    test('Shows the ancestor commits of the working copy', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');
        repo.describe('first commit');
        repo.new();
        repo.writeFile('b.txt', 'b\n');
        repo.describe('second commit');
        repo.new();
        repo.writeFile('c.txt', 'c\n');

        const parentId = repo.getChangeId('@-');
        const grandParentId = repo.getChangeId('@--');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        // Working copy row plus both ancestor groups, which start collapsed.
        await expect(frame.locator('.scm-resource-item', { hasText: 'c.txt' })).toBeVisible({ timeout: 5000 });
        await expect(frame.locator(`[data-change-id="${parentId}"]`)).toBeVisible({ timeout: 5000 });
        await expect(frame.locator(`[data-change-id="${grandParentId}"]`)).toBeVisible({ timeout: 5000 });
    });

    test('Shows the same commits in JJ Log and Changes right after startup', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a1\n');
        repo.describe('first commit');
        repo.new();
        repo.writeFile('a.txt', 'a2\n');
        repo.writeFile('b.txt', 'b1\n');

        const parentId = repo.getChangeId('@-');

        const { page } = await vscode.openWorkspace(repo);

        // Both views must agree on the history as soon as the window is up: the commit shown
        // as the parent in JJ Log is the ancestor group in Changes.
        await vscode.executeCommand('jj-view.logView.focus');
        const logFrame = await getLogWebview(page);
        await expect(logFrame.locator(`[data-change-id="${parentId}"]`)).toHaveCount(1, { timeout: 5000 });

        await vscode.executeCommand('jj-view.changesView.focus');
        const changesFrame = await getWebviewFrame(page, 'jj-changes-root');
        await expect(changesFrame.locator(`[data-change-id="${parentId}"]`)).toHaveCount(1, { timeout: 5000 });
        await expect(changesFrame.locator('.scm-resource-item', { hasText: 'b.txt' })).toBeVisible({ timeout: 5000 });
    });
});
