/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { makeTestTmpDir } from '../test-tmp-root';
import { expectNotificationToast, getLogWebview, openFileInEditor, test } from './e2e-helpers';

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

    test('Splits a file into a new commit above from the file context menu', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('base.txt', 'base\n');
        repo.describe('base');
        repo.new();
        repo.writeFile('a.txt', 'a\n');
        repo.writeFile('b.txt', 'b\n');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        const row = frame.locator('.scm-resource-item', { hasText: 'a.txt' }).first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await row.click({ button: 'right' });

        const splitAbove = frame.locator('button.menu-item', { hasText: 'Split File into New Commit Above' });
        const splitBelow = frame.locator('button.menu-item', { hasText: 'Split File into New Commit Below' });
        await expect(splitAbove).toBeVisible({ timeout: 5000 });
        await expect(splitBelow).toBeVisible({ timeout: 5000 });
        await splitAbove.click();

        // A new empty commit is inserted above the working copy and owns the file change.
        await expect.poll(() => repo.getChildren(repo.getChangeId('@')).length, { timeout: 5000 }).toBe(1);
        const [splitId] = repo.getChildren(repo.getChangeId('@'));
        expect(repo.getFileContent(splitId, 'a.txt')).toBe('a\n');

        // The working copy keeps the other file.
        expect(repo.getFileContent('@', 'b.txt')).toBe('b\n');
    });

    test('Expands the source commit and the new commit after splitting', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('base.txt', 'base\n');
        repo.describe('base');
        repo.new();
        repo.writeFile('a.txt', 'a\n');
        repo.writeFile('b.txt', 'b\n');
        repo.describe('target');
        repo.new();

        const targetId = repo.getChangeId('@-');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.changesView.focus');

        // Collapse the JJ Log pane: the sidebar is short, and with both panes open the
        // Changes list only shows one ancestor group, hiding the commit created by the split.
        const logPane = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
        if ((await logPane.getAttribute('aria-expanded')) !== 'false') {
            await logPane.click();
        }
        await expect(logPane).toHaveAttribute('aria-expanded', 'false');

        const frame = await getWebviewFrame(page, 'jj-changes-root');

        // Real flow: the file row only exists after the user expands the group.
        const targetHeader = frame.locator(`[data-change-id="${targetId}"]`);
        await expect(targetHeader).toBeVisible({ timeout: 5000 });
        await targetHeader.locator('.chevron-icon').click();

        const row = frame.locator('.scm-resource-item', { hasText: 'a.txt' }).first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await row.click({ button: 'right' });
        await frame.locator('button.menu-item', { hasText: 'Split File into New Commit Below' }).click();

        // Behaviour only: each file is visible exactly once, which can only happen when both
        // ancestor groups (the source keeping b.txt and the new one owning a.txt) are expanded.
        await expect(frame.locator('.scm-resource-item', { hasText: 'a.txt' })).toHaveCount(1);
        await expect(frame.locator('.scm-resource-item', { hasText: 'b.txt' })).toHaveCount(1);
        // Exactly the two ancestor groups are expanded; the older base stays collapsed.
        await expect(frame.locator('[data-change-id] .codicon-chevron-down')).toHaveCount(2);
    });

    test('Refuses to split when the commit has only one file', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('base.txt', 'base\n');
        repo.describe('base');
        repo.new();
        repo.writeFile('a.txt', 'a\n');
        repo.describe('target');
        repo.new();

        const targetId = repo.getChangeId('@-');

        const { page } = await vscode.openWorkspace(repo, {}, {}, true);
        await vscode.executeCommand('jj-view.changesView.focus');

        const logPane = page.locator('.pane-header', { hasText: 'JJ Log' }).first();
        if ((await logPane.getAttribute('aria-expanded')) !== 'false') {
            await logPane.click();
        }

        const frame = await getWebviewFrame(page, 'jj-changes-root');

        const targetHeader = frame.locator(`[data-change-id="${targetId}"]`);
        await expect(targetHeader).toBeVisible({ timeout: 5000 });
        await targetHeader.locator('.chevron-icon').click();

        const row = frame.locator('.scm-resource-item', { hasText: 'a.txt' }).first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await row.click({ button: 'right' });
        await frame.locator('button.menu-item', { hasText: 'Split File into New Commit Below' }).click();

        // The source commit still holds its only file: nothing was emptied out.
        expect(repo.getFileContent(targetId, 'a.txt')).toBe('a\n');

        // And the command explains why it did nothing.
        await expectNotificationToast(page, 'nothing to split');
    });

    test('Commits to the repository shown in Changes when another repo file is open', async ({ vscode }) => {
        // One parent folder, two jj repos inside it, opened as a single workspace folder.
        const parent = makeTestTmpDir('jj-view-parent-');
        const alpha = new TestRepo(path.join(parent, 'alpha'));
        const beta = new TestRepo(path.join(parent, 'beta'));

        alpha.init();
        alpha.writeFile('a.txt', 'a1\n');
        alpha.describe('alpha base');
        alpha.new();
        alpha.writeFile('a.txt', 'a2\n');

        beta.init();
        beta.writeFile('b.txt', 'b1\n');
        beta.describe('beta base');
        beta.new();

        const betaHeadBefore = beta.getChangeId('@-');

        // The workspace root is a plain folder holding two repos: enable subfolder detection
        // (the e2e defaults disable it) and wait for any discovered repository.
        const { page } = await vscode.openWorkspace(
            { path: parent, waitForRepository: false },
            { 'jj-view.detectSubRepositories': true },
        );

        // The active editor belongs to beta while the Changes view targets alpha.
        await openFileInEditor(vscode, page, 'b.txt');
        await vscode.executeCommand('jj-view.reposView.focus');
        const reposFrame = await getWebviewFrame(page, 'jj-repos-root');
        await expect.poll(() => reposFrame.locator('[data-testid="jj-repo-row"]').count(), { timeout: 5000 }).toBe(2);

        const alphaRow = reposFrame.locator('[data-testid="jj-repo-row"]', { hasText: 'alpha' }).first();
        await expect(alphaRow).toBeVisible({ timeout: 5000 });
        await alphaRow.locator('button').first().click();

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');
        await frame.locator('[data-testid="scm-input-textarea"]').fill('commit to alpha');
        // The Changes view commits through the view title button, which runs this command.
        await vscode.executeCommand('jj-view.commit');

        // beta must stay exactly as it was: no commit may land in the repository that merely
        // owns the active editor.
        expect(beta.getLog('@-', 'description')).toBe('beta base');
        expect(beta.getChangeId('@-')).toBe(betaHeadBefore);

        // alpha must receive the commit.
        expect(alpha.getLog('@-', 'description')).toContain('commit to alpha');
        expect(alpha.getFileContent('@-', 'a.txt')).toBe('a2\n');

        // Opening beta's file must not steal the focused repository from alpha.
        await vscode.executeCommand('jj-view.logView.focus');
        await expect(page.locator('.pane-header', { hasText: `JJ Log (alpha)` }).first()).toBeVisible({
            timeout: 5000,
        });
    });

    test('Commits the typed description after switching the open document', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');
        repo.writeFile('b.txt', 'b\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        const input = frame.locator('[data-testid="scm-input-textarea"]');
        await expect(input).toBeVisible({ timeout: 5000 });
        await input.fill('draft message');

        // Switching the open document triggers a refresh (and a state push) before committing.
        await openFileInEditor(vscode, page, 'b.txt');
        await page.waitForTimeout(500);

        // Same command the view title bar's commit button runs.
        await vscode.executeCommand('jj-view.commit');

        await expect.poll(() => repo.getLog('@-', 'description'), { timeout: 5000 }).toContain('draft message');
    });

    test('Commits the typed description after switching to another project', async ({ vscode }) => {
        const parent = makeTestTmpDir('jj-view-draft-');
        const alpha = new TestRepo(path.join(parent, 'alpha'));
        const beta = new TestRepo(path.join(parent, 'beta'));

        alpha.init();
        alpha.writeFile('a.txt', 'a\n');
        alpha.describe('alpha base');
        alpha.new();
        alpha.writeFile('a.txt', 'a2\n');

        beta.init();
        beta.writeFile('b.txt', 'b1\n');
        beta.describe('beta base');
        beta.new();

        const { page } = await vscode.openWorkspace(
            { path: parent, waitForRepository: false },
            { 'jj-view.detectSubRepositories': true },
        );

        await vscode.executeCommand('jj-view.reposView.focus');
        const reposFrame = await getWebviewFrame(page, 'jj-repos-root');
        await expect.poll(() => reposFrame.locator('[data-testid="jj-repo-row"]').count(), { timeout: 5000 }).toBe(2);
        await reposFrame
            .locator('[data-testid="jj-repo-row"]', { hasText: 'alpha' })
            .first()
            .locator('button')
            .first()
            .click();

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');
        const input = frame.locator('[data-testid="scm-input-textarea"]');
        await expect(input).toBeVisible({ timeout: 5000 });
        await input.fill('draft in alpha');

        // Open a document from the other project before committing.
        await openFileInEditor(vscode, page, 'b.txt');
        await page.waitForTimeout(500);

        await vscode.executeCommand('jj-view.commit');

        await expect.poll(() => alpha.getLog('@-', 'description'), { timeout: 5000 }).toContain('draft in alpha');

        // A committed draft must not be reused by the next commit.
        await input.fill('second draft');
        await openFileInEditor(vscode, page, 'a.txt');
        await page.waitForTimeout(300);
        alpha.writeFile('a.txt', 'a3\n');
        await vscode.executeCommand('jj-view.commit');

        await expect.poll(() => alpha.getLog('@-', 'description'), { timeout: 5000 }).toContain('second draft');
    });

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

    test('Keeps a newly committed group collapsed', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        await frame.locator('[data-testid="scm-input-textarea"]').fill('commit it');
        await vscode.executeCommand('jj-view.commit');

        await expect.poll(() => repo.getLog('@-', 'description'), { timeout: 5000 }).toContain('commit it');
        const committedId = repo.getChangeId('@-');
        const committedHeader = frame.locator(`[data-change-id="${committedId}"]`);
        await expect(committedHeader).toBeVisible({ timeout: 5000 });
        await expect(committedHeader.locator('.codicon-chevron-right')).toBeVisible();

        // The Working Copy group stays expanded.
        await expect(frame.locator('[data-testid="scm-group-working-copy"] .codicon-chevron-down')).toBeVisible();
    });

    test('Clears the Changes view right after committing', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        // Scope to the Working Copy group: after the commit the same file belongs to the
        // new ancestor group, which this test does not assert.
        const row = frame.locator('[data-testid="scm-group-working-copy"] .scm-resource-item', { hasText: 'a.txt' });
        await expect(row).toBeVisible({ timeout: 5000 });

        await frame.locator('[data-testid="scm-input-textarea"]').fill('commit it');
        await vscode.executeCommand('jj-view.commit');

        // No repository switch: the view itself must pick up the post-commit snapshot.
        await expect(row).toHaveCount(0, { timeout: 5000 });
        expect(repo.getLog('@-', 'description')).toContain('commit it');
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

    test('Committing twice does not create an empty second commit', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        await frame.locator('[data-testid="scm-input-textarea"]').fill('commit it');
        await vscode.executeCommand('jj-view.commit');
        await expect.poll(() => repo.getLog('@-', 'description'), { timeout: 5000 }).toContain('commit it');

        const workingCopyAfterFirst = repo.getChangeId('@');
        const headAfterFirst = repo.getChangeId('@-');

        // Second click with nothing left to commit must be a no-op.
        await vscode.executeCommand('jj-view.commit');

        expect(repo.getChangeId('@')).toBe(workingCopyAfterFirst);
        expect(repo.getChangeId('@-')).toBe(headAfterFirst);
    });

    test('Untracks a working-copy folder from the tree context menu', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('keep.txt', 'keep\n');
        repo.writeFile('src/a.txt', 'a\n');
        repo.writeFile('src/nested/b.txt', 'b\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');
        await vscode.executeCommand('jj-view.changesAsTree');

        const folder = frame.locator('[data-testid="scm-tree-folder-src"]');
        await expect(folder).toBeVisible({ timeout: 5000 });
        await folder.click({ button: 'right' });

        const untrack = frame.locator('[data-testid="menu-item-jj-view.untrack"]');
        await expect(untrack).toBeVisible({ timeout: 5000 });
        await untrack.click();

        await expect(frame.locator('.scm-resource-item', { hasText: 'a.txt' })).toHaveCount(0, { timeout: 5000 });
        await expect(frame.locator('.scm-resource-item', { hasText: 'b.txt' })).toHaveCount(0, { timeout: 5000 });
        expect(fs.readFileSync(path.join(repo.path, '.gitignore'), 'utf8')).toContain('/src/');

        // Leave the shared window on the list layout for the other tests.
        await vscode.executeCommand('jj-view.changesAsList');
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
