/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the state version from the file names inside `.jj/repo/store/op_heads/heads`.
 *
 * Every jj operation (ours or the user's) writes there, so the sorted names identify the
 * repository state without spawning jj. Comparing versions is what replaces the old
 * "ignore events for 1.5s after our own command" window.
 */
export function composeOpHeadsVersion(names: readonly string[]): string {
    return [...names]
        .filter((name) => name.length > 0)
        .sort()
        .join(',');
}

/**
 * True when a snapshot computed from `captured` must not be applied because the repository
 * moved on (`current` differs). Both must be known: an unreadable version means "unknown",
 * and discarding unknown results would wipe the UI.
 */
export function isStaleSnapshot(captured: string | undefined, current: string | undefined): boolean {
    return Boolean(captured) && Boolean(current) && captured !== current;
}
