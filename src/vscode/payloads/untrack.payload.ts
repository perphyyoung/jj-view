/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectResourceStates } from '../../core/commands/command-utils';
import type { UntrackPayload } from '../../core/commands/untrack';

const uniquePaths = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

/** Accepts a tree folder payload (`{ paths, folder }`) or one or more resource states. */
export function createUntrackPayload(args: unknown[]): UntrackPayload {
    const first = args[0];
    if (first && typeof first === 'object' && Array.isArray((first as { paths?: unknown }).paths)) {
        const folder = (first as { folder?: unknown }).folder;
        return {
            paths: uniquePaths((first as { paths: unknown[] }).paths.filter((p): p is string => typeof p === 'string')),
            ...(typeof folder === 'string' && folder.length > 0 ? { folder } : {}),
        };
    }

    const paths = collectResourceStates(args)
        .map((state) => state.relativePath ?? '')
        .filter(Boolean);
    return { paths: uniquePaths(paths) };
}
