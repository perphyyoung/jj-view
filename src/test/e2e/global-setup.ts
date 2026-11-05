/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { VSCODE_TEST_VERSION } from './vscode-version';

/**
 * Downloads and unzips VS Code sequentially before Playwright spawns parallel
 * worker threads, preventing race conditions (e.g., 'tar: Cannot mkdir') when
 * multiple workers attempt to extract the archive to the same directory.
 *
 * The version is pinned: an unpinned download resolves `stable` every run, so the host
 * silently changed and each run queried the update API.
 */
async function globalSetup() {
    process.stdout.write(`Preparing VS Code ${VSCODE_TEST_VERSION} (Global Setup)...\n`);
    await downloadAndUnzipVSCode({ version: VSCODE_TEST_VERSION });
    process.stdout.write('VS Code ready.\n');
}

export default globalSetup;
