/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { diffArrays } from 'diff';

/**
 * Maps line numbers of the buffer to the same lines in a committed version of the file.
 *
 * `jj diff -r <commit>` groups changes by the line numbers of the file **at that commit**,
 * so looking up a change with the current buffer line misses as soon as anything above was
 * inserted or removed later. Mapping the line through a local diff fixes that, and it also
 * accounts for unsaved edits because the buffer text is the source of truth.
 *
 * Only lines whose content is unchanged get an entry: a line that was rewritten has no
 * counterpart in the committed version.
 *
 * @param commitLines lines of the file at the blamed commit
 * @param bufferLines lines of the buffer being annotated
 * @returns buffer line (0-based) to commit line (0-based)
 */
export function buildBufferToCommitLineMap(
    commitLines: readonly string[],
    bufferLines: readonly string[],
): Map<number, number> {
    const map = new Map<number, number>();
    // Comparing line arrays avoids the trailing-newline mismatch that `diffLines` has when
    // one side ends with a newline and the other does not.
    const changes = diffArrays([...commitLines], [...bufferLines]);

    let commitLine = 0;
    let bufferLine = 0;
    for (const change of changes) {
        const count = change.count ?? 0;
        if (!change.added && !change.removed) {
            for (let offset = 0; offset < count; offset++) {
                map.set(bufferLine + offset, commitLine + offset);
            }
            commitLine += count;
            bufferLine += count;
            continue;
        }
        if (change.removed) {
            commitLine += count;
        } else {
            bufferLine += count;
        }
    }
    return map;
}
