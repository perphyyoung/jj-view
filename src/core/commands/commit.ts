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
    /** Change id of the commit that now sits at `@-`. */
    changeId?: string;
}

/**
 * Commits the working copy.
 *
 * Idempotent: an empty working copy is a no-op, so clicking the commit button twice cannot
 * create an empty commit. After the commit it verifies the working copy is really empty and
 * reveals the new commit in the Changes view, so "committed" always means "the view can show
 * the post-commit state".
 */
export async function commitCommand(ctx: CommandContext, payload?: CommitPayload): Promise<CommitResult> {
    let description = payload?.description?.trim() ?? '';
    if (description) {
        description = await maybeFormatDescriptionOnSave(description, ctx);
    }
    try {
        const jj = ctx.repo.jj;
        const [before, currentDescription] = await Promise.all([
            jj.getLog({ revision: '@', limit: 1 }),
            jj.getDescription('@'),
        ]);
        const pending = before[0]?.changes?.length ?? 0;
        // Idempotent: a second click finds an empty working copy whose description already
        // matches, and must not create another empty commit. An explicit new description on
        // an empty working copy still commits (creating an empty commit is intentional then).
        if (pending === 0 && currentDescription.trim() === description) {
            ctx.log.info?.('[Commit] nothing to commit: the working copy is empty and the description is unchanged');
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

        const committed = await jj.getLog({ revision: '@-', limit: 1 });
        const changeId = committed[0]?.change_id;
        if (changeId) {
            // Expand and scroll to the commit the Changes view must now show.
            try {
                await ctx.host.commands.executeCommand('jj-view.revealChangesGroup', {
                    root: ctx.repo.rootUri.fsPath,
                    changeId,
                });
            } catch {
                // The Changes view may not be registered (headless runs); not an error.
            }
        }
        return { committed: true, changeId };
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error committing change', ctx.repo.jj, ctx.log);
        return { committed: false };
    }
}
