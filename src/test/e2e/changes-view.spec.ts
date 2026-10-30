/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { test } from './e2e-helpers';

async function getWebviewFrame(page: Page, testId: string, timeout = 20000): Promise<Frame> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            try {
                if ((await frame.locator(`[data-testid="${testId}"]`).count()) > 0) {
                    return frame;
                }
            } catch {
                // Frame may be navigating; retry on the next tick.
            }
        }
        await page.waitForTimeout(200);
    }
    throw new Error(`Webview frame containing [data-testid="${testId}"] was not found`);
}

test.describe('JJ View Container E2E', () => {
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
});
