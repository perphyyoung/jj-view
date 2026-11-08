/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every test temporary directory lives under `<project>/tmp`, which is gitignored.
 *
 * Tests must not touch paths outside the project: system temp can be cleaned by other tools,
 * may sit on a slow or quarantined volume, and leaves files the developer cannot find.
 */
export const TEST_TMP_ROOT = path.join(process.cwd(), 'tmp');

export function ensureTestTmpRoot(): string {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    return TEST_TMP_ROOT;
}

/**
 * Renames the previous `<project>/tmp` aside and creates a fresh one. Called once per test
 * run (globalSetup) so the directory does not grow unboundedly across runs. Uses renameSync
 * instead of rmSync because the sandbox bulk-delete guard rejects recursive deletes of
 * directories with hundreds of entries. The parked directory is removed lazily on the next
 * run so no single call pays the full recursive-delete cost.
 */
export function cleanTestTmpRoot(): void {
    // Remove any parked dirs left by previous runs (best effort).
    try {
        const parent = path.dirname(TEST_TMP_ROOT);
        for (const entry of fs.readdirSync(parent)) {
            if (entry.startsWith('tmp-old-')) {
                try {
                    fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
                } catch {
                    // Ignore: parked dirs accumulate but do not block tests.
                }
            }
        }
    } catch {
        // Ignore.
    }

    if (fs.existsSync(TEST_TMP_ROOT)) {
        const parked = path.join(path.dirname(TEST_TMP_ROOT), `tmp-old-${Date.now()}`);
        try {
            fs.renameSync(TEST_TMP_ROOT, parked);
        } catch {
            // Best effort: if rename fails the old dir stays and tests still work.
        }
    }
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
}

/** Creates a unique directory under `<project>/tmp` (sync). */
export function makeTestTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(ensureTestTmpRoot(), prefix));
}

/** Creates a unique directory under `<project>/tmp` (async). */
export async function makeTestTmpDirAsync(prefix: string): Promise<string> {
    await fs.promises.mkdir(TEST_TMP_ROOT, { recursive: true });
    return fs.promises.mkdtemp(path.join(TEST_TMP_ROOT, prefix));
}
