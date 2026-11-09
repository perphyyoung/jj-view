/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { maybeFormatDescriptionOnSave } from './command-utils';

export interface CommitPayload {
    description?: string;
}

export interface CommitResult {
    /** False when there was nothing to commit (idempotent no-op). */
    committed: boolean;
}

/**
 * Commits the working copy.
 *
 * Idempotent: an empty working copy is a no-op, so clicking the commit button twice cannot
 * create an empty commit. After the commit it verifies the working copy is really empty, so
 * "committed" always means "the view can show the post-commit state".
 */
export async function commitCommand(ctx: CommandContext, payload?: CommitPayload): Promise<CommitResult> {
    let description = payload?.description?.trim() ?? '';
    if (description) {
        description = await maybeFormatDescriptionOnSave(description, ctx);
    }
    try {
        const jj = ctx.repo.jj;
        const before = await jj.getLog({ revision: '@', limit: 1 });
        // No empty commits under any condition: a commit must carry changes. This also makes
        // the button idempotent — a second click finds nothing to commit and does nothing.
        if ((before[0]?.changes?.length ?? 0) === 0) {
            ctx.log.info?.('[Commit] rejected: nothing to commit (empty working copy)');
            await ctx.host.ui.showInformation('Empty commits are not allowed.');
            return { committed: false };
        }

        await ctx.host.ui.withProgress('Committing...', () => jj.commit(description));
        await ctx.repo.refresh({ forceSnapshot: true, checkVersion: true, reason: 'after commit' });

        // Post-condition: a successful commit leaves `@` empty. Retry once; a persistent
        // failure is logged so a stale view is diagnosable instead of silent.
        const head = await jj.getLog({ revision: '@', limit: 1 });
        if ((head[0]?.changes?.length ?? 0) > 0) {
            ctx.log.info?.('[Commit] post-condition failed: working copy not empty after commit, refreshing again');
            await ctx.repo.refresh({ forceSnapshot: true, checkVersion: true, reason: 'after commit (retry)' });
        }

        return { committed: true };
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error committing change', ctx.repo.jj, ctx.log);
        return { committed: false };
    }
}
