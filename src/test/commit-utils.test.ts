/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CommitAction } from '../core/host/ipc/log-view-schemas';
import type { JjLogEntry } from '../core/jj-types';
import { computeCommitActions } from '../core/webview/log/utils/commit-utils';

/**
 * `computeCommitActions` is a pure projection of a log entry. The old repo-tier version
 * created a real jj repository for every case just to obtain an object with these flags.
 */
function commit(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    return {
        commit_id: 'commit-b',
        change_id: 'change-b',
        description: 'B',
        author: { name: 'Test User', email: 'test@example.com', timestamp: '2026-11-08T00:00:00Z' },
        committer: { name: 'Test User', email: 'test@example.com', timestamp: '2026-11-08T00:00:00Z' },
        parents: [{ commit_id: 'commit-a', change_id: 'change-a', is_immutable: false }],
        bookmarks: [],
        is_immutable: false,
        is_current_working_copy: false,
        ...overrides,
    };
}

const immutableParent = [{ commit_id: 'root', change_id: 'root', is_immutable: true }];
const mutableParent = [{ commit_id: 'commit-a', change_id: 'change-a', is_immutable: false }];

describe('computeCommitActions', () => {
    it('should show all actions when everything is mutable and nothing is hidden', () => {
        const result = computeCommitActions(commit(), new Set<CommitAction>(), false, 0, false);

        expect(result.visibleActions).toEqual({ newChild: true, edit: true, squash: true, abandon: true });
        expect(result.vscodeContext['jj.canEdit']).toBe(true);
        expect(result.vscodeContext['jj.canAbandon']).toBe(true);
    });

    it('should hide immutable actions', () => {
        const result = computeCommitActions(
            commit({ is_immutable: true, parents: [] }),
            new Set<CommitAction>(),
            false,
            0,
            false,
        );

        expect(result.visibleActions.edit).toBe(false);
        expect(result.visibleActions.abandon).toBe(false);
        expect(result.vscodeContext['jj.canEdit']).toBe(false);
        expect(result.vscodeContext['jj.canAbandon']).toBe(false);
    });

    it('should respect hiddenActions', () => {
        const result = computeCommitActions(commit(), new Set<CommitAction>(['newChild', 'squash']), false, 0, false);

        expect(result.visibleActions.newChild).toBe(false);
        expect(result.visibleActions.squash).toBe(false);
        expect(result.visibleActions.edit).toBe(true);
        expect(result.visibleActions.abandon).toBe(true);
    });

    it('should only allow squash if there is exactly one mutable parent', () => {
        const childOfRoot = computeCommitActions(commit({ parents: immutableParent }), new Set(), false, 0, false);
        expect(childOfRoot.visibleActions.squash).toBe(false);

        const childOfMutable = computeCommitActions(commit(), new Set(), false, 0, false);
        expect(childOfMutable.visibleActions.squash).toBe(true);

        const merge = computeCommitActions(
            commit({ parents: [...mutableParent, ...immutableParent] }),
            new Set(),
            false,
            0,
            false,
        );
        expect(merge.visibleActions.squash).toBe(false);
    });

    it('should handle selection states correctly', () => {
        const single = computeCommitActions(commit(), new Set(), true, 1, false);
        expect(single.vscodeContext.viewItem).toBe('jj-commit-selected');
        expect(single.vscodeContext['jj.canEdit']).toBe(true);

        const multi = computeCommitActions(commit(), new Set(), true, 2, false);
        expect(multi.vscodeContext['jj.canEdit']).toBe(false);
        expect(multi.vscodeContext['jj.canMerge']).toBe(true);
    });

    it('should prevent rebase onto self', () => {
        const result = computeCommitActions(commit(), new Set(), true, 1, false);
        expect(result.vscodeContext['jj.canRebaseOnto']).toBe(false);
    });

    it('should allow rebase onto selection when not selected', () => {
        const result = computeCommitActions(commit(), new Set(), false, 1, false);
        expect(result.vscodeContext['jj.canRebaseOnto']).toBe(true);
    });

    it('should only allow absorb if at least one parent is mutable', () => {
        const childOfRoot = computeCommitActions(commit({ parents: immutableParent }), new Set(), false, 0, false);
        expect(childOfRoot.vscodeContext['jj.canAbsorb']).toBe(false);

        const childOfMutable = computeCommitActions(commit(), new Set(), false, 0, false);
        expect(childOfMutable.vscodeContext['jj.canAbsorb']).toBe(true);
    });

    it('should restrict canAbsorb and canEdit to single selection', () => {
        const selectedMulti = computeCommitActions(commit(), new Set(), true, 2, false);
        expect(selectedMulti.vscodeContext['jj.canEdit']).toBe(false);
        expect(selectedMulti.vscodeContext['jj.canAbsorb']).toBe(false);

        const unselected = computeCommitActions(commit(), new Set(), false, 2, false);
        expect(unselected.vscodeContext['jj.canEdit']).toBe(true);
        expect(unselected.vscodeContext['jj.canAbsorb']).toBe(true);
    });

    it('should disable multi-item actions if selection contains immutable commits', () => {
        const result = computeCommitActions(commit(), new Set(), true, 2, true);

        expect(result.vscodeContext['jj.canAbandon']).toBe(false);
        expect(result.vscodeContext['jj.canNewBefore']).toBe(false);
        expect(result.vscodeContext['jj.canNewAfter']).toBe(false);
    });

    it('should handle canNewChild and canDuplicate in single-item context', () => {
        const single = computeCommitActions(commit(), new Set(), true, 1, false);
        expect(single.vscodeContext['jj.canNewChild']).toBe(true);
        expect(single.vscodeContext['jj.canDuplicate']).toBe(true);

        const multi = computeCommitActions(commit(), new Set(), true, 2, false);
        expect(multi.vscodeContext['jj.canNewChild']).toBe(false);
        expect(multi.vscodeContext['jj.canDuplicate']).toBe(false);
    });

    it('should hide Edit for current working copy', () => {
        const result = computeCommitActions(commit({ is_current_working_copy: true }), new Set(), false, 0, false);

        expect(result.visibleActions.edit).toBe(false);
        expect(result.vscodeContext['jj.canEdit']).toBe(false);
    });
});
