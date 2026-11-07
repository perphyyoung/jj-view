/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** One commit in a line's history, as reported by `git log -L`. */
export interface LineHistoryEntry {
    /** Full commit id (git sha, identical to jj's commit id). */
    sha: string;
    author: string;
    /** Author date in ISO-8601. */
    date: string;
    /** First line of the commit message. */
    summary: string;
}

/** Entries shown before the "Load more" item. */
export const LINE_HISTORY_PAGE_SIZE = 10;

/**
 * Upper bound for one query. `git log -L` walks history itself, so a single call is cheap;
 * fetching everything up front keeps paging local and the "N remaining" count exact.
 */
export const LINE_HISTORY_MAX_ENTRIES = 200;

/** Field separator used in `--format`, unlikely to appear in commit metadata. */
const FIELD_SEPARATOR = '\u0000';

/**
 * Builds the `git log -L` invocation.
 *
 * `--no-patch` keeps only the tracked line metadata (verified against git 2.54: the line
 * tracking still works, output drops from ~34 KB to ~0.9 KB). The start revision is an
 * explicit commit id, so repositories without a checkout (non-colocated jj) work too.
 */
export function buildLineHistoryArgs(options: {
    gitDir: string;
    filePath: string;
    /** 1-based line number. */
    line: number;
    startSha: string;
    limit?: number;
}): string[] {
    return [
        `--git-dir=${options.gitDir}`,
        'log',
        '-L',
        `${options.line},${options.line}:${options.filePath}`,
        // `%x00` emits the NUL at runtime: a literal NUL cannot be passed in argv.
        '--format=%H%x00%an%x00%aI%x00%s',
        '--no-patch',
        '-n',
        String(options.limit ?? LINE_HISTORY_MAX_ENTRIES),
        options.startSha,
    ];
}

/** Parses the `--format` output; malformed lines are ignored. */
export function parseLineHistoryOutput(stdout: string): LineHistoryEntry[] {
    const entries: LineHistoryEntry[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        const parts = trimmed.split(FIELD_SEPARATOR);
        if (parts.length < 4) {
            continue;
        }
        const [sha, author, date, ...summary] = parts;
        entries.push({ sha, author, date, summary: summary.join(FIELD_SEPARATOR) });
    }
    return entries;
}

/** Short id used in the picker, long enough to stay recognizable in this branch. */
export function shortSha(sha: string): string {
    return sha.slice(0, 8);
}

/** True when another page exists for the given number of visible entries. */
export function hasMoreEntries(total: number, visible: number): boolean {
    return visible < total;
}

export interface LineHistoryPage {
    entries: LineHistoryEntry[];
    hasMore: boolean;
    remaining: number;
}

/** Slices one page out of the full list (paging is local: the query is a single call). */
export function sliceLineHistoryPage(
    entries: readonly LineHistoryEntry[],
    visible: number,
    pageSize: number = LINE_HISTORY_PAGE_SIZE,
): LineHistoryPage {
    const end = Math.min(visible + pageSize, entries.length);
    return {
        entries: entries.slice(visible, end),
        hasMore: end < entries.length,
        remaining: Math.max(entries.length - end, 0),
    };
}
