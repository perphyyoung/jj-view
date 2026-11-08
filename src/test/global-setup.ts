/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanTestTmpRoot } from './test-tmp-root';

/**
 * Runs once before the test suite starts (Vitest globalSetup).
 * Clears `<project>/tmp` so the directory does not grow unboundedly across runs.
 */
export function setup(): void {
    cleanTestTmpRoot();
}
