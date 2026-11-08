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

/** Creates a unique directory under `<project>/tmp` (sync). */
export function makeTestTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(ensureTestTmpRoot(), prefix));
}

/** Creates a unique directory under `<project>/tmp` (async). */
export async function makeTestTmpDirAsync(prefix: string): Promise<string> {
    await fs.promises.mkdir(TEST_TMP_ROOT, { recursive: true });
    return fs.promises.mkdtemp(path.join(TEST_TMP_ROOT, prefix));
}
