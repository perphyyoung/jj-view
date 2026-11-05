/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { openFileInEditor, test } from './e2e-helpers';

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

    test('Expands the group of a commit created by splitting an ancestor file', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('base.txt', 'base\n');
        repo.describe('base');
        repo.new();
        repo.writeFile('a.txt', 'a\n');
        repo.describe('target');
        repo.new();

        const targetId = repo.getChangeId('@-');
        const baseId = repo.getChangeId('@--');

        const { page } = await vscode.openWorkspace(repo);

        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        // Ancestor groups start collapsed: expand the one that owns the file. Click the
        // chevron: the header centre is covered by the inline action buttons.
        const targetHeader = frame.locator(`[data-change-id="${targetId}"]`);
        await expect(targetHeader).toBeVisible({ timeout: 5000 });
        await targetHeader.locator('.chevron-icon').click();

        const row = frame.locator('.scm-resource-item', { hasText: 'a.txt' }).first();
        await expect(row).toBeVisible({ timeout: 5000 });
        await row.click({ button: 'right' });
        await frame.locator('button.menu-item', { hasText: 'Split File into New Commit Below' }).click();

        // The new commit lands between base and target and must be shown expanded.
        await expect.poll(() => repo.getChildren(baseId).length, { timeout: 5000 }).toBe(1);
        const [newId] = repo.getChildren(baseId);
        const newHeader = frame.locator(`[data-change-id="${newId}"]`);
        await expect(newHeader).toBeVisible({ timeout: 5000 });
        await expect(newHeader.locator('.codicon-chevron-down')).toBeVisible();
        await expect(frame.locator('.scm-resource-item', { hasText: 'a.txt' })).toHaveCount(1);
    });

    test('Commits to the repository shown in Changes when another repo file is open', async ({ vscode }) => {
        // One parent folder, two jj repos inside it, opened as a single workspace folder.
        const parent = mkdtempSync(path.join(os.tmpdir(), 'jj-view-parent-'));
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
            { 'jj-view.autoRepositoryDetection': true },
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
        const parent = mkdtempSync(path.join(os.tmpdir(), 'jj-view-draft-'));
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
            { 'jj-view.autoRepositoryDetection': true },
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
        const parent = mkdtempSync(path.join(os.tmpdir(), 'jj-view-sort-'));
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
            { 'jj-view.autoRepositoryDetection': true },
        );

        await vscode.executeCommand('jj-view.reposView.focus');
        const frame = await getWebviewFrame(page, 'jj-repos-root');
        const rows = frame.locator('[data-testid="jj-repo-row"]');
        await expect.poll(() => rows.count(), { timeout: 5000 }).toBe(2);

        const header = page.locator('.pane-header', { hasText: 'Repositories' }).first();
        await expect(header).toContainText('Workspace', { timeout: 5000 });

        // Two changes in alpha, none in beta.
        await vscode.executeCommand('jj-view.reposSort', 'changeCount');
        await expect(rows.first()).toContainText('alpha');
        await expect(header).toContainText('Changes', { timeout: 5000 });

        await vscode.executeCommand('jj-view.reposSort', 'nameDesc');
        await expect(rows.first()).toContainText('beta');

        // Leave the shared window on the default ordering for the other tests.
        await vscode.executeCommand('jj-view.reposSort', 'workspace');
        await expect(rows.first()).toContainText('alpha');
    });

    test('Clears the Changes view right after committing', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('a.txt', 'a\n');

        const { page } = await vscode.openWorkspace(repo);
        await vscode.executeCommand('jj-view.changesView.focus');
        const frame = await getWebviewFrame(page, 'jj-changes-root');

        const row = frame.locator('.scm-resource-item', { hasText: 'a.txt' });
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
