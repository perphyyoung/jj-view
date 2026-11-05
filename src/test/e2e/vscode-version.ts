/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The VS Code version the e2e host runs.
 *
 * Without a version, `downloadAndUnzipVSCode()` resolves `stable` on every run, so the test
 * host silently changed (1.144.0 -> 1.144.1 -> 1.145.0) and each run hit the update API.
 * The version lives in `tooling/vscode-version.json` (shared with the integration configs);
 * `JVL_VSCODE_VERSION` overrides it explicitly for one-off experiments.
 */
function readPinnedVersion(): string {
    const override = process.env.JVL_VSCODE_VERSION?.trim();
    if (override) {
        return override;
    }
    // Compiled location: out/test/e2e/ -> project root.
    const file = path.resolve(__dirname, '../../../tooling/vscode-version.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    if (!parsed.version) {
        throw new Error(`Missing "version" in ${file}`);
    }
    return parsed.version;
}

export const VSCODE_TEST_VERSION = readPinnedVersion();
