/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';

export interface UntrackPayload {
    /** Repository-relative file paths. */
    paths: string[];
    /** Repository-relative folder the paths came from, when untracking a tree folder. */
    folder?: string;
}

const normalizeEntry = (value: string): string =>
    value
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/\/+$/, '');

/**
 * `jj file untrack` only accepts paths that are already ignored, so the ignore rules are
 * written first. They go to the focused repository's root `.gitignore`: in a multi-repo
 * workspace the Changes view always targets the focused repository.
 */
async function addIgnoreRules(ctx: CommandContext, paths: readonly string[], folder?: string): Promise<void> {
    const fs = ctx.host.system?.fs;
    if (!fs) {
        return;
    }

    const ignorePath = path.join(ctx.repo.rootUri.fsPath, '.gitignore');
    let content = '';
    try {
        content = await fs.readTextFile(ignorePath);
    } catch {
        // Missing .gitignore: start a new one.
    }

    const existing = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const rules: string[] = [];
    const pushRule = (rule: string): void => {
        if (!existing.has(rule)) {
            existing.add(rule);
            rules.push(rule);
        }
    };

    for (const filePath of paths) {
        const entry = normalizeEntry(filePath);
        if (entry) {
            pushRule(`/${entry}`);
        }
    }
    if (folder) {
        const entry = normalizeEntry(folder);
        if (entry) {
            pushRule(`/${entry}/`);
        }
    }

    if (rules.length === 0) {
        return;
    }

    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await fs.writeTextFile(ignorePath, `${content}${separator}${rules.join('\n')}\n`);
}

export async function untrackCommand(ctx: CommandContext, payload?: UntrackPayload): Promise<void> {
    const paths = [...new Set((payload?.paths ?? []).map((value) => value.trim()).filter(Boolean))];
    if (paths.length === 0) {
        return;
    }

    try {
        await addIgnoreRules(ctx, paths, payload?.folder);
        await ctx.host.ui.withProgress('Untracking files...', () => ctx.repo.jj.fileUntrack(paths));
    } catch (e: unknown) {
        await showJjError(ctx.host.ui, e, 'Failed to untrack files', ctx.repo.jj, ctx.log);
    }
}
