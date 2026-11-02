/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Frame, type Page } from '@playwright/test';
import { buildGraph, type CommitId, TestRepo } from '../test-repo';
import { focusJJViewLocal, openFileInEditor, test, waitForLogCommitRow, waitForTab } from './e2e-helpers';

/** Finds the webview frame that renders the Repositories view. */
async function getReposFrame(page: Page): Promise<Frame> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            try {
                if ((await frame.locator('[data-testid="jj-repos-root"]').count()) > 0) {
                    return frame;
                }
            } catch {
                // Frame may be navigating; retry.
            }
        }
        await page.waitForTimeout(100);
    }
    throw new Error('Repositories webview frame was not found');
}

test.describe('Multi-Repo Switching E2E', () => {
    let mainRepo: TestRepo;
    let secondRepo: TestRepo;
    let mainCommits: Record<string, CommitId>;
    let page: Page;

    test.beforeEach(async ({ vscode }) => {
        mainRepo = new TestRepo();
        mainRepo.init();

        // 1. Set up graph for main repo
        mainCommits = await buildGraph(mainRepo, [
            { label: 'main-base', description: 'main base commit', files: { 'main_file.txt': 'main content' } },
            {
                label: 'main-wc',
                parents: ['main-base'],
                description: 'main WC message',
                files: { 'main_file.txt': 'modified main content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 2. Set up second repo as a sibling repo
        secondRepo = new TestRepo();
        secondRepo.init();

        // 3. Set up graph for second repo
        await buildGraph(secondRepo, [
            { label: 'second-base', description: 'second base commit', files: { 'second_file.txt': 'second content' } },
            {
                label: 'second-wc',
                parents: ['second-base'],
                description: 'second WC message',
                files: { 'second_file.txt': 'modified second content' },
                isCurrentWorkingCopy: true,
            },
        ]);

        // 4. Create a multi-root code-workspace file
        const workspaceConfigPath = path.join(mainRepo.path, 'multi.code-workspace');
        fs.writeFileSync(
            workspaceConfigPath,
            JSON.stringify(
                {
                    folders: [{ path: mainRepo.path }, { path: secondRepo.path }],
                },
                null,
                2,
            ),
        );

        // Fake repo object with path pointing to the .code-workspace file
        const fakeRepo = {
            path: workspaceConfigPath,
        };

        const setup = await vscode.openWorkspace(fakeRepo, {
            'workbench.editor.enablePreview': false,
        });
        page = setup.page;
    });

    test.afterEach(async () => {
        if (secondRepo) {
        }
        if (mainRepo) {
        }
    });

    test('opening another project file keeps the current repository', async ({ vscode }) => {
        const mainRepoFolderName = path.basename(mainRepo.path);
        const secondRepoFolderName = path.basename(secondRepo.path);

        // Verify initial focused repository is main repo by checking log view
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');

        // Opening a file from the other project must not steal the focused repository.
        await openFileInEditor(vscode, page, 'second_file.txt');
        await page.waitForTimeout(500);
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${secondRepoFolderName})` }).first()).toHaveCount(
            0,
        );
        await waitForLogCommitRow(page, 'main base commit');

        // Same for commit-details editors belonging to the other project.
        const mainBaseRow = await waitForLogCommitRow(page, 'main base commit');
        await mainBaseRow.click();
        const mainShortId = mainCommits['main-base'].changeId.substring(0, 3);
        await waitForTab(page, new RegExp(`^Commit: ${mainShortId}`));

        await page.getByRole('tab', { name: 'second_file.txt' }).click();
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');
    });

    test('repository switching from the Repositories view', async ({ vscode }) => {
        const mainRepoFolderName = path.basename(mainRepo.path);
        const secondRepoFolderName = path.basename(secondRepo.path);

        // Verify initial focused repository is main repo by checking log view
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');

        await vscode.executeCommand('jj-view.reposView.focus');
        const reposFrame = await getReposFrame(page);

        await reposFrame
            .locator('[data-testid="jj-repo-row"]', { hasText: secondRepoFolderName })
            .first()
            .locator('button')
            .first()
            .click();

        // Verify repository manager switched focus to the second repo by checking log view
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${secondRepoFolderName})` }).first()).toBeVisible(
            { timeout: 5000 },
        );
        await waitForLogCommitRow(page, 'second base commit');

        await vscode.executeCommand('jj-view.reposView.focus');
        await reposFrame
            .locator('[data-testid="jj-repo-row"]', { hasText: mainRepoFolderName })
            .first()
            .locator('button')
            .first()
            .click();

        // Verify repository manager switched focus back to the main repo by checking log view
        await focusJJViewLocal(page);
        await expect(page.locator('.pane-header', { hasText: `JJ Log (${mainRepoFolderName})` }).first()).toBeVisible({
            timeout: 5000,
        });
        await waitForLogCommitRow(page, 'main base commit');
    });
});
