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
    /** What the tracked line looked like in this commit (undefined when unparsable). */
    text?: string;
}

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

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DETAIL_LIMIT = 100;

/** One line for the picker's second row: the tracked line's text, clipped. */
export function clipDetail(text: string, limit: number = DETAIL_LIMIT): string {
    const singleLine = text.replace(/\r$/, '');
    return singleLine.length > limit ? `${singleLine.slice(0, limit - 1)}…` : singleLine;
}

/**
 * Extracts the tracked line's text per commit from the same `git log -L` output.
 *
 * `-L` prints each commit's patch; walking newest to oldest and following the line through
 * the hunks yields what the line looked like in every listed commit, with no extra git call.
 * Parsing failures only cost the detail row, never the list.
 */
export function extractLineTexts(stdout: string, startLine: number): Map<string, string> {
    const texts = new Map<string, string>();
    let line = startLine;

    const commits = stdout.split('\n');
    let i = 0;
    while (i < commits.length) {
        const header = commits[i];
        const parts = header.split(FIELD_SEPARATOR);
        if (parts.length < 4 || !/^[0-9a-f]{7,40}$/.test(parts[0])) {
            i++;
            continue;
        }
        const sha = parts[0];
        i++;

        let oldNo = 0;
        let newNo = 0;
        let pending: number[] = [];
        let text: string | undefined;
        let parentLine: number | undefined;

        for (; i < commits.length; i++) {
            const raw = commits[i];
            const nextParts = raw.split(FIELD_SEPARATOR);
            if (nextParts.length >= 4 && /^[0-9a-f]{7,40}$/.test(nextParts[0])) {
                break;
            }
            const hunk = HUNK_HEADER.exec(raw);
            if (hunk) {
                oldNo = Number(hunk[1]);
                newNo = Number(hunk[3]);
                pending = [];
                continue;
            }
            if (raw.startsWith('\\')) {
                continue;
            }
            const kind = raw[0];
            if (kind === ' ') {
                if (newNo === line && text === undefined) {
                    text = raw.slice(1);
                    parentLine = oldNo;
                }
                oldNo++;
                newNo++;
                pending = [];
            } else if (kind === '-') {
                pending.push(oldNo);
                oldNo++;
            } else if (kind === '+') {
                if (newNo === line && text === undefined) {
                    text = raw.slice(1);
                    parentLine = pending[0];
                }
                newNo++;
            }
        }

        if (text !== undefined) {
            texts.set(sha, text);
        }
        if (parentLine !== undefined) {
            line = parentLine;
        }
    }

    return texts;
}

/** Everything the Line History panel needs for one file:line target. */
export interface LineHistoryPanelPayload {
    root: string;
    /** Repo-relative path. */
    path: string;
    /** 1-based line number. */
    line: number;
    entries: LineHistoryEntry[];
}
