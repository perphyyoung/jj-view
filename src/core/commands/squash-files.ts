/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CommandContext } from '../host/command-context';
import { promptForRevision, showJjError } from '../host/ui-helpers';
import { RevisionQuery } from './command-utils';

export interface SquashFilesIntoParentPayload {
    paths: string[];
    revision?: string;
}

export interface SquashFilesIntoAncestorPayload {
    paths: string[];
    revision?: string;
    ancestorRevision?: string;
}

export interface SquashFilesIntoChildPayload {
    paths: string[];
    revision?: string;
    childRevision?: string;
}

export interface SplitFileIntoCommitPayload {
    path: string;
    revision?: string;
}

/**
 * Moves a single file out of `revision` into a brand-new empty commit placed directly
 * above or below it (`jj squash --from <rev> -A|-B <rev>`). The source commit is kept even
 * when it becomes empty, so the user never loses it by surprise.
 */
async function splitFileIntoNewCommit(
    ctx: CommandContext,
    payload: SplitFileIntoCommitPayload | undefined,
    placement: 'above' | 'below',
): Promise<void> {
    const path = payload?.path;
    if (!path) {
        return;
    }

    const revision = payload?.revision || '@';
    const label = `Splitting file into a new commit ${placement}...`;
    const neighbourOf = (rev: string) =>
        placement === 'above' ? ctx.repo.jj.getChildren(rev) : ctx.repo.jj.getParents(rev);

    try {
        // Splitting the only file would just move the whole commit, leaving an empty one
        // behind. Tell the user instead of creating that empty commit.
        const [sourceEntry] = await ctx.repo.jj.getLog({ revision, limit: 1 });
        if ((sourceEntry?.changes?.length ?? 0) <= 1) {
            await ctx.host.ui.showInformation('This commit has only one file, so there is nothing to split.');
            return;
        }

        // The new commit has no id we know upfront: it is whatever neighbour appears
        // around the source revision after the operation.
        const before = await neighbourOf(revision).catch(() => [] as string[]);

        await ctx.host.ui.withProgress(label, () =>
            ctx.repo.jj.squashRevision({
                paths: [path],
                revision,
                ...(placement === 'above' ? { insertAfterRevision: revision } : { insertBeforeRevision: revision }),
                keepEmptied: true,
            }),
        );
        await ctx.repo.refresh({ reason: `after split file into a new commit ${placement}` });

        const after = await neighbourOf(revision).catch(() => [] as string[]);
        const newChangeId = after.find((id) => !before.includes(id));
        // Reveal both groups: the source keeps the other files, the new commit owns the
        // split-out file. Identifying the new commit needs the id diff above.
        const changeIds = [sourceEntry?.change_id, newChangeId].filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
        );
        if (changeIds.length > 0) {
            try {
                await ctx.host.commands.executeCommand('jj-view.revealChangesGroup', {
                    root: ctx.repo.rootUri.fsPath,
                    changeIds,
                });
            } catch {
                // The Changes view may not be registered (headless runs); not an error.
            }
        }
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, `Error splitting file into a new commit ${placement}`, ctx.repo.jj, ctx.log);
    }
}

export async function squashFilesIntoParentCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoParentPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        await ctx.host.ui.withProgress('Squashing file(s) into parent...', () =>
            ctx.repo.jj.squashRevision({ paths, revision, useDestinationMessage: true }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into parent' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into parent', ctx.repo.jj, ctx.log);
    }
}

export async function squashFilesIntoAncestorCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoAncestorPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        let selectedAncestorRev = payload?.ancestorRevision;
        if (!selectedAncestorRev) {
            selectedAncestorRev = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                placeHolder: 'Select which ancestor to squash into',
                revisionQuery: RevisionQuery.mutableAncestorsExcluding(revision),
                repoRoot: ctx.repo.rootUri,
                nav: ctx.host.nav,
            });
        }
        if (!selectedAncestorRev) {
            return;
        }

        await ctx.host.ui.withProgress('Squashing file(s) into ancestor...', () =>
            ctx.repo.jj.squashRevision({
                paths,
                revision,
                intoRevision: selectedAncestorRev,
                useDestinationMessage: true,
            }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into ancestor' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into ancestor', ctx.repo.jj, ctx.log);
    }
}

export async function splitFileIntoCommitAboveCommand(
    ctx: CommandContext,
    payload?: SplitFileIntoCommitPayload,
): Promise<void> {
    return splitFileIntoNewCommit(ctx, payload, 'above');
}

export async function splitFileIntoCommitBelowCommand(
    ctx: CommandContext,
    payload?: SplitFileIntoCommitPayload,
): Promise<void> {
    return splitFileIntoNewCommit(ctx, payload, 'below');
}

export async function squashFilesIntoChildCommand(
    ctx: CommandContext,
    payload?: SquashFilesIntoChildPayload,
): Promise<void> {
    const paths = payload?.paths ?? [];
    if (paths.length === 0) {
        return;
    }

    const revision = payload?.revision || '@';

    try {
        const children = await ctx.repo.jj.getChildren(revision);
        let targetChild = payload?.childRevision;

        if (!targetChild) {
            if (children.length === 0) {
                const revDisplay = revision === '@' ? 'the working copy' : revision;
                await showJjError(
                    ctx.host.ui,
                    new Error(`No child commits to squash changes into for ${revDisplay}.`),
                    'Squash Error',
                    ctx.repo.jj,
                    ctx.log,
                );
                return;
            } else if (children.length === 1) {
                targetChild = children[0];
            } else {
                targetChild = await promptForRevision(ctx.host.ui, ctx.repo.jj, {
                    placeHolder: `Select child commit for ${revision}`,
                    revisionQuery: RevisionQuery.children(revision),
                    repoRoot: ctx.repo.rootUri,
                    nav: ctx.host.nav,
                });
            }
        }

        if (!targetChild) {
            return;
        }

        await ctx.host.ui.withProgress('Squashing file(s) into child...', () =>
            ctx.repo.jj.squashRevision({
                paths,
                revision,
                intoRevision: targetChild,
                useDestinationMessage: true,
            }),
        );
        await ctx.repo.refresh({ reason: 'after squash file(s) into child' });
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Error squashing file(s) into child', ctx.repo.jj, ctx.log);
    }
}
