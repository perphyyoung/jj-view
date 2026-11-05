/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Result of comparing one repository's view data against the repository truth. */
export interface VersionCheck {
    /** No artifact is older than `truth`. */
    ok: boolean;
    /** The SCM snapshot (feeds Changes + Repos counts) is older than `truth`. */
    staleSnapshot: boolean;
    /** The JJ Log data is older than `truth`. */
    staleLog: boolean;
}

/**
 * Compares the state version each view published with the repository truth.
 *
 * `truth` is the op_heads version read from disk, which changes on every jj operation.
 * An unknown version never marks data stale: without evidence we keep the current UI instead
 * of flashing empty states on repositories whose op_heads directory is unreadable.
 */
export function verifyVersions(input: {
    truth: string | undefined;
    snapshotVersion: string | undefined;
    logVersion: string | undefined;
}): VersionCheck {
    const truth = input.truth || '';
    if (!truth) {
        return { ok: true, staleSnapshot: false, staleLog: false };
    }
    const staleSnapshot = Boolean(input.snapshotVersion) && input.snapshotVersion !== truth;
    const staleLog = Boolean(input.logVersion) && input.logVersion !== truth;
    return { ok: !staleSnapshot && !staleLog, staleSnapshot, staleLog };
}
