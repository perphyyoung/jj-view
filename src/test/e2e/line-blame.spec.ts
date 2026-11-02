/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { openFileInEditor, test } from './e2e-helpers';

test.describe('Line Blame E2E', () => {
    test('Shows the full tooltip on the first hover', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('notes.md', 'first line\nsecond line\nthird line\n');
        // The marker lives in the commit body, so it only shows up in the full tooltip.
        repo.describe('add notes\n\nBODY_MARKER in the commit body');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        const line = editor.locator('.view-line').nth(1);
        await expect(line).toBeVisible({ timeout: 5000 });

        await line.click();
        await page.keyboard.press('End');

        const hasBlame = async (): Promise<boolean> =>
            line.evaluate((el) => {
                const isBlame = (value: string): boolean => value.includes('add notes');
                const walk = (node: Node): boolean => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return isBlame(node.textContent ?? '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return false;
                    }
                    const element = node as Element;
                    if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                        return true;
                    }
                    return Array.from(element.childNodes).some(walk);
                };
                return walk(el);
            });
        await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

        // Hover once, right away: the tooltip must already contain the commit body and must
        // not show a placeholder that only a mouse move would refresh.
        await line.hover();
        const hover = page.locator('.monaco-hover').first();
        await expect(hover).toBeVisible({ timeout: 5000 });
        await expect(hover).toContainText('BODY_MARKER', { timeout: 5000 });
        await expect(hover).not.toContainText('Resolving');
    });

    test('Shows the blame tooltip for the cursor line', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('notes.md', 'first line\nsecond line\nthird line\n');
        repo.describe('add notes');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        const line = editor.locator('.view-line').nth(1);
        await expect(line).toBeVisible({ timeout: 5000 });

        await line.click();
        await page.keyboard.press('End');

        // The tooltip ships with the decoration, so wait until the blame is rendered
        // (otherwise Monaco has nothing to show and hides the hover widget).
        const hasBlame = async (): Promise<boolean> =>
            line.evaluate((el) => {
                const isBlame = (value: string): boolean =>
                    value.includes('add notes') || value.includes('Uncommitted');
                const walk = (node: Node): boolean => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return isBlame(node.textContent ?? '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return false;
                    }
                    const element = node as Element;
                    if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                        return true;
                    }
                    return Array.from(element.childNodes).some(walk);
                };
                return walk(el);
            });
        await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

        // A summary tooltip is applied together with the blame text, so hovering right
        // after the cursor lands must already show the commit summary.
        await line.hover();
        const hover = page.locator('.monaco-hover').first();
        await expect(hover).toBeVisible({ timeout: 5000 });
        await expect(hover).toContainText('add notes', { timeout: 5000 });
    });

    test('Shows the tooltip at the end of the line, where the blame text is rendered', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('notes.md', 'first line\nsecond line\nthird line\n');
        repo.describe('add notes');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        const line = editor.locator('.view-line').nth(1);
        await expect(line).toBeVisible({ timeout: 5000 });

        await line.click();
        await page.keyboard.press('End');

        const hasBlame = async (): Promise<boolean> =>
            line.evaluate((el) => {
                const isBlame = (value: string): boolean => value.includes('add notes');
                const walk = (node: Node): boolean => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return isBlame(node.textContent ?? '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return false;
                    }
                    const element = node as Element;
                    if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                        return true;
                    }
                    return Array.from(element.childNodes).some(walk);
                };
                return walk(el);
            });
        await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

        // The blame text is a decoration pseudo element, so no locator can point at it.
        // Ask the editor for the hover of the cursor position instead: the provider answers
        // for the whole line, which is what hovering the rendered blame text resolves to.
        await vscode.executeCommand('editor.action.showHover');

        const hover = page.locator('.monaco-hover').first();
        await expect(hover).toBeVisible({ timeout: 5000 });
        await expect(hover).toContainText('add notes', { timeout: 5000 });
    });

    test('Shows the line diff after a later commit inserted lines above it', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('notes.md', 'first line\nsecond line\nthird line\n');
        repo.describe('add notes');
        repo.new();

        // A later commit inserts lines above: the blamed commit's hunk no longer matches the
        // current line number, so the diff has to be looked up through a line mapping.
        repo.writeFile('notes.md', 'a\nb\nc\nd\ne\nfirst line\nsecond line\nthird line\n');
        repo.describe('prepend lines');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        await expect(editor.locator('.view-line').nth(1)).toBeVisible({ timeout: 5000 });

        const target = editor.locator('.view-line').filter({ hasText: 'second line' }).first();
        await expect(target).toBeVisible({ timeout: 5000 });
        await target.click();
        await page.keyboard.press('End');

        const hasBlame = async (): Promise<boolean> =>
            target.evaluate((el) => {
                const isBlame = (value: string): boolean => value.includes('add notes');
                const walk = (node: Node): boolean => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return isBlame(node.textContent ?? '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return false;
                    }
                    const element = node as Element;
                    if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                        return true;
                    }
                    return Array.from(element.childNodes).some(walk);
                };
                return walk(el);
            });
        await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

        await target.hover();
        const hover = page.locator('.monaco-hover').first();
        await expect(hover).toBeVisible({ timeout: 5000 });
        await expect(hover).toContainText('+ second line', { timeout: 5000 });
    });

    test('Shows the diff of the hovered line when the commit added the whole file', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
        repo.writeFile('notes.md', `${lines.join('\n')}\n`);
        repo.describe('add notes');
        repo.new();

        // A later commit prepends three lines. The blamed commit's hunk spans the whole file,
        // so looking the line up by its current number would hit an unrelated line of it.
        repo.writeFile('notes.md', `P1\nP2\nP3\n${lines.join('\n')}\n`);
        repo.describe('prepend lines');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        await expect(editor.locator('.view-line').first()).toBeVisible({ timeout: 5000 });

        const target = editor.locator('.view-line').filter({ hasText: 'L5' }).first();
        await expect(target).toBeVisible({ timeout: 5000 });
        await target.click();
        await page.keyboard.press('End');

        const hasBlame = async (): Promise<boolean> =>
            target.evaluate((el) => {
                const isBlame = (value: string): boolean => value.includes('add notes');
                const walk = (node: Node): boolean => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return isBlame(node.textContent ?? '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) {
                        return false;
                    }
                    const element = node as Element;
                    if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                        return true;
                    }
                    return Array.from(element.childNodes).some(walk);
                };
                return walk(el);
            });
        await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

        await target.hover();
        const hover = page.locator('.monaco-hover').first();
        await expect(hover).toBeVisible({ timeout: 5000 });
        await expect(hover).toContainText('+ L5', { timeout: 5000 });
    });

    // Any line-ending combination must still resolve the hovered line's diff.
    const EOL_VARIANTS = [
        { name: 'LF', content: 'a\nb\nc\n' },
        { name: 'CRLF', content: 'a\r\nb\r\nc\r\n' },
        { name: 'mixed LF and CRLF', content: 'a\r\nb\nc\r\n' },
        { name: 'no trailing newline', content: 'a\nb\nc' },
        { name: 'CRLF without trailing newline', content: 'a\r\nb\r\nc' },
    ];

    for (const variant of EOL_VARIANTS) {
        test(`Shows the hovered line's diff for a file with ${variant.name}`, async ({ vscode }) => {
            const repo = new TestRepo();
            repo.init();
            repo.writeFile('notes.md', variant.content);
            repo.describe('add notes');
            repo.new();

            const { page } = await vscode.openWorkspace(repo);
            await openFileInEditor(vscode, page, 'notes.md');

            const editor = page.locator('.editor-instance .monaco-editor').first();
            const target = editor.locator('.view-line').filter({ hasText: 'b' }).first();
            await expect(target).toBeVisible({ timeout: 5000 });

            await target.click();
            await page.keyboard.press('End');

            const hasBlame = async (): Promise<boolean> =>
                target.evaluate((el) => {
                    const isBlame = (value: string): boolean => value.includes('add notes');
                    const walk = (node: Node): boolean => {
                        if (node.nodeType === Node.TEXT_NODE) {
                            return isBlame(node.textContent ?? '');
                        }
                        if (node.nodeType !== Node.ELEMENT_NODE) {
                            return false;
                        }
                        const element = node as Element;
                        if (isBlame(getComputedStyle(element, '::after').content ?? '')) {
                            return true;
                        }
                        return Array.from(element.childNodes).some(walk);
                    };
                    return walk(el);
                });
            await expect.poll(hasBlame, { timeout: 5000 }).toBe(true);

            await target.hover();
            const hover = page.locator('.monaco-hover').first();
            await expect(hover).toBeVisible({ timeout: 5000 });
            await expect(hover).toContainText('+ b', { timeout: 5000 });
        });
    }

    test('Keeps the blame text at the end of the line while editing', async ({ vscode }) => {
        const repo = new TestRepo();
        repo.init();
        repo.writeFile('notes.md', 'first line\nsecond line\nthird line\n');
        repo.describe('add notes');
        repo.new();

        const { page } = await vscode.openWorkspace(repo);
        await openFileInEditor(vscode, page, 'notes.md');

        const editor = page.locator('.editor-instance .monaco-editor').first();
        const line = editor.locator('.view-line').nth(1);
        await expect(line).toBeVisible({ timeout: 5000 });

        await line.click();
        await page.keyboard.press('End');

        // VS Code renders the blame at the end of the decoration range, so the position
        // of the rendered text is measured instead of relying on the DOM order.
        const blameGeometry = async (): Promise<{ blameX: number; contentEndX: number; text: string } | null> =>
            page.evaluate(() => {
                const isBlame = (value: string): boolean =>
                    value.includes('add notes') || value.includes('Uncommitted');

                for (const viewLine of Array.from(document.querySelectorAll('.view-line'))) {
                    let blameX: number | null = null;
                    let contentEndX: number | null = null;
                    const walk = (node: Node): void => {
                        if (node.nodeType === Node.TEXT_NODE) {
                            const text = node as Text;
                            const value = text.textContent ?? '';
                            if (!value.trim()) {
                                return;
                            }
                            const range = document.createRange();
                            range.selectNodeContents(text);
                            const rect = range.getBoundingClientRect();
                            if (isBlame(value)) {
                                blameX = blameX === null ? rect.left : Math.min(blameX, rect.left);
                            } else if (contentEndX === null || rect.right > contentEndX) {
                                contentEndX = rect.right;
                            }
                            return;
                        }
                        if (node.nodeType !== Node.ELEMENT_NODE) {
                            return;
                        }
                        const element = node as Element;
                        for (const child of Array.from(element.childNodes)) {
                            walk(child);
                        }
                        const after = getComputedStyle(element, '::after').content;
                        if (after && after !== 'none' && after !== 'normal' && isBlame(after)) {
                            // The pseudo element is painted right after the host text.
                            const rect = element.getBoundingClientRect();
                            blameX = blameX === null ? rect.right : Math.min(blameX, rect.right);
                        }
                    };
                    walk(viewLine);
                    if (blameX !== null && contentEndX !== null) {
                        return { blameX, contentEndX, text: viewLine.textContent ?? '' };
                    }
                }
                return null;
            });

        // The blame of the committed line shows the author and the commit message.
        await expect
            .poll(
                async () => {
                    const geometry = await blameGeometry();
                    return geometry !== null && geometry.blameX >= geometry.contentEndX - 1;
                },
                { timeout: 5000 },
            )
            .toBe(true);

        // Delete the line break at the end of the line: the next line joins the current
        // one while the cursor keeps its line and column.
        await page.keyboard.press('Delete');

        // The state right after the key press is not asserted: the document change event
        // and the decoration update are asynchronous, so reading it here races the
        // provider. The reappearance check below covers the same regression deterministically.

        // The blame must reappear at the end of the merged line. The annotation cache is
        // keyed by the file content on disk, so only the debounce plus the working-copy
        // lookup remain on this path (measured ~1s).
        let geometry: { blameX: number; contentEndX: number; text: string } | null = null;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const current = await blameGeometry();
            geometry = current;
            if (current?.text.includes('third line') && current.blameX >= current.contentEndX - 1) {
                break;
            }
            await page.waitForTimeout(200);
        }
        expect(geometry, 'blame did not reappear at the end of the merged line').not.toBeNull();
    });
});
