/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from '@playwright/test';
import { TestRepo } from '../test-repo';
import { openFileInEditor, test } from './e2e-helpers';

test.describe('Line Blame E2E', () => {
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

        // Right after the edit the blame must not be painted inside the line: the
        // provider drops the stale decoration, so it is either gone or already
        // anchored to the end of the merged line.
        const immediate = await blameGeometry();
        if (immediate) {
            expect(immediate.blameX).toBeGreaterThanOrEqual(immediate.contentEndX - 1);
        }

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
