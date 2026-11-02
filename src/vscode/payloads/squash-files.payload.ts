/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    collectResourceStates,
    extractAncestorRevision,
    extractChildRevision,
    extractRevision,
} from '../../core/commands/command-utils';
import type {
    SplitFileIntoCommitPayload,
    SquashFilesIntoAncestorPayload,
    SquashFilesIntoChildPayload,
    SquashFilesIntoParentPayload,
} from '../../core/commands/squash-files';
import { getFsPathFromUri } from '../../core/uri-utils';

export function createSquashFilesIntoParentPayload(args: unknown[]): SquashFilesIntoParentPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    return { paths, revision };
}

export function createSquashFilesIntoAncestorPayload(args: unknown[]): SquashFilesIntoAncestorPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    const ancestorRevision = extractAncestorRevision(args, revision);
    return { paths, revision, ancestorRevision };
}

export function createSplitFileIntoCommitPayload(args: unknown[]): SplitFileIntoCommitPayload {
    // Splitting always targets a single file, so only the first selected resource counts.
    const [resourceState] = collectResourceStates(args);
    const path = resourceState ? getFsPathFromUri(resourceState.resourceUri) : '';
    const revision = extractRevision(args) || '@';
    return { path, revision };
}

export function createSquashFilesIntoChildPayload(args: unknown[]): SquashFilesIntoChildPayload {
    const resourceStates = collectResourceStates(args);
    const paths = resourceStates.map((r) => getFsPathFromUri(r.resourceUri));
    const revision = extractRevision(args) || '@';
    const childRevision = extractChildRevision(args, revision);
    return { paths, revision, childRevision };
}
