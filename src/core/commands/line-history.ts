/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import {
    buildLineHistoryArgs,
    clipDetail,
    extractLineTexts,
    hasMoreEntries,
    LINE_HISTORY_MAX_ENTRIES,
    LINE_HISTORY_PAGE_SIZE,
    type LineHistoryEntry,
    parseLineHistoryOutput,
    shortSha,
} from '../blame/line-history';
import type { CommandContext } from '../host/command-context';
import { showJjError } from '../host/ui-helpers';
import { createRevisionUri } from '../uri-utils';

/** Accepts both the hover link shape (`path`/`line`) and the editor context shape. */
export interface LineHistoryPayload {
    root?: string;
    /** Repo-relative path. */
    path?: string;
    /** Absolute path, as provided by the editor context menu. */
    fileName?: string;
    /** 1-based line. */
    line?: number;
    /** 0-based line, as provided by the editor context menu. */
    lineNumber?: number;
}

/**
 * Normalizes the shapes a command can receive.
 *
 * The hover link sends `{root, path, line}`; `editor/context` sends `{fileName, lineNumber}`
 * (occasionally only a URI, which the VS Code layer converts to the fallback below); and the
 * command palette sends nothing at all, where the active editor is the only source.
 */
export function normalizeLineHistoryPayload(
    arg: unknown,
    fallback: { fileName?: string; lineNumber?: number } = {},
    root?: string,
): LineHistoryPayload | undefined {
    const payload: LineHistoryPayload = { root };
    if (arg && typeof arg === 'object') {
        const record = arg as Record<string, unknown>;
        if (typeof record.root === 'string' && record.root) {
            payload.root = record.root;
        }
        if (typeof record.path === 'string' && record.path) {
            payload.path = record.path;
        }
        if (typeof record.fileName === 'string' && record.fileName) {
            payload.fileName = record.fileName;
        }
        if (typeof record.line === 'number' && Number.isInteger(record.line) && record.line > 0) {
            payload.line = record.line;
        }
        if (typeof record.lineNumber === 'number' && Number.isInteger(record.lineNumber) && record.lineNumber >= 0) {
            payload.lineNumber = record.lineNumber;
        }
    }
    if (!payload.fileName && !payload.path && fallback.fileName) {
        payload.fileName = fallback.fileName;
    }
    if (payload.line === undefined && payload.lineNumber === undefined && fallback.lineNumber !== undefined) {
        payload.lineNumber = fallback.lineNumber;
    }
    return payload.fileName || payload.path ? payload : undefined;
}

interface ResolvedTarget {
    root: string;
    absolutePath: string;
    relativePath: string;
    line: number;
}

function resolveTarget(ctx: CommandContext, payload: LineHistoryPayload | undefined): ResolvedTarget | undefined {
    const root = payload?.root || ctx.repo.rootUri.fsPath;
    const absolutePath = payload?.fileName ?? (payload?.path ? path.join(root, payload.path) : undefined);
    if (!absolutePath) {
        return undefined;
    }
    const line = payload?.line ?? (payload?.lineNumber !== undefined ? payload.lineNumber + 1 : undefined);
    if (!line || line < 1) {
        return undefined;
    }
    return { root, absolutePath, relativePath: path.relative(root, absolutePath), line };
}

/** `.git` for colocated repositories, the store for jj-only ones. */
async function resolveGitDir(ctx: CommandContext, root: string): Promise<string | undefined> {
    const fs = ctx.host.system?.fs;
    if (!fs) {
        return undefined;
    }
    const colocated = path.join(root, '.git');
    if (await fs.exists(colocated)) {
        return colocated;
    }
    const store = path.join(root, '.jj', 'repo', 'store', 'git');
    return (await fs.exists(store)) ? store : undefined;
}

function formatItem(entry: LineHistoryEntry): {
    label: string;
    description: string;
    detail?: string;
    value: LineHistoryEntry;
} {
    return {
        label: `$(git-commit) ${shortSha(entry.sha)} ${entry.summary}`,
        description: `${entry.author} · ${entry.date.slice(0, 10)}`,
        // Second row: what the line looked like in this commit. The sha is already in the
        // label, so repeating it here only wastes the row.
        ...(entry.text ? { detail: clipDetail(entry.text) } : {}),
        value: entry,
    };
}

/**
 * Shows the committed history of one line.
 *
 * jj has no `git log -L` equivalent, and walking per-commit diffs is two orders of magnitude
 * slower (measured: 37s vs 83ms for 105 vs 21 commits), so git does the line tracking. Commit
 * ids are git shas, so selecting an entry opens the matching jj diff.
 */
export async function lineHistoryCommand(ctx: CommandContext, payload?: LineHistoryPayload): Promise<void> {
    ctx.log.debug?.(`[LineHistory] payload=${JSON.stringify(payload)}`);
    const target = resolveTarget(ctx, payload);
    if (!target) {
        await ctx.host.ui.showInformation(
            payload?.fileName
                ? 'Line History needs a cursor line; place the cursor on a line and try again.'
                : 'Open Line History from a line-blame hover or the editor context menu.',
        );
        return;
    }
    const gitDir = await resolveGitDir(ctx, target.root);
    if (!gitDir) {
        await ctx.host.ui.showInformation('Line history requires a git-backed repository.');
        return;
    }

    try {
        const [startSha] = await ctx.repo.jj.getLogIds({ revision: '@-', limit: 1 });
        if (!startSha) {
            return;
        }
        const result = await ctx.host.system?.process.execFile(
            'git',
            buildLineHistoryArgs({
                gitDir,
                filePath: target.relativePath,
                line: target.line,
                startSha,
                limit: LINE_HISTORY_MAX_ENTRIES,
            }),
            { cwd: target.root, timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
        );
        const stdout = result?.stdout ?? '';
        const entries = parseLineHistoryOutput(stdout);
        const texts = extractLineTexts(stdout, target.line);
        for (const entry of entries) {
            entry.text = texts.get(entry.sha);
        }
        if (entries.length === 0) {
            await ctx.host.ui.showInformation('No committed history for this line.');
            return;
        }
        await runPicker(ctx, target, entries);
    } catch (err: unknown) {
        await showJjError(ctx.host.ui, err, 'Error loading line history', ctx.repo.jj, ctx.log);
    }
}

async function runPicker(ctx: CommandContext, target: ResolvedTarget, entries: LineHistoryEntry[]): Promise<void> {
    let visible = LINE_HISTORY_PAGE_SIZE;
    for (;;) {
        const page = entries.slice(0, visible);
        const items = page.map(formatItem);
        if (hasMoreEntries(entries.length, visible)) {
            items.push({
                label: '$(ellipsis) Load more…',
                description: `${entries.length - visible} remaining`,
                detail: '',
                value: null as unknown as LineHistoryEntry,
            });
        }
        const picked = await ctx.host.ui.showQuickPick(items, {
            title: 'Line History',
            placeHolder: `Line ${target.line}: ${path.basename(target.relativePath)} — ${Math.min(visible, entries.length)} of ${entries.length} commits`,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) {
            return;
        }
        if (!picked.value) {
            visible += LINE_HISTORY_PAGE_SIZE;
            continue;
        }
        await openEntryDiff(ctx, target, picked.value);
        return;
    }
}

async function openEntryDiff(ctx: CommandContext, target: ResolvedTarget, entry: LineHistoryEntry): Promise<void> {
    const left = createRevisionUri(target.root, target.absolutePath, `parents(${entry.sha})`);
    const right = createRevisionUri(target.root, target.absolutePath, entry.sha);
    await ctx.host.nav.openDiff(
        left,
        right,
        `${path.basename(target.relativePath)} @ ${shortSha(entry.sha)} — ${entry.summary}`,
    );
}
