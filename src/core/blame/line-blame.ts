/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { differsOnlyInvisibly } from '../../utils/eol-utils';

/** One annotated line as reported by `jj file annotate`. */
export interface LineAnnotation {
    /** 1-based line number inside the file. */
    line: number;
    /** Full commit id of the commit that last touched the line. */
    commitId: string;
    /** Abbreviated commit id, used in the hover tooltip only. */
    shortCommitId: string;
    /** Author name. */
    author: string;
    /**
     * Commit time in epoch milliseconds (committer timestamp, the one `jj log` shows).
     *
     * Stored absolute so the relative label is computed at render time: caching a formatted
     * "13 minutes ago" made the hover freeze while the clock moved on.
     */
    timestamp: number;
    /** First line of the commit description. */
    summary: string;
}

/** Extra commit metadata resolved on demand for the hover tooltip. */
export interface CommitDetails {
    /** Full commit message (may span multiple lines). */
    description?: string;
}

export interface FormatLineBlameOptions {
    /** Hard limit for the rendered text (default 100 characters). */
    maxLength?: number;
    /** The line was modified in the working copy and has no committed state yet. */
    uncommitted?: boolean;
    /** Clock used for the relative time (defaults to `Date.now()`, injectable for tests). */
    now?: number;
}

const DEFAULT_MAX_LENGTH = 100;

/**
 * Parses `jj file annotate -T '<line>\t<commit>\t<short>\t<author>\t<epoch>\t<summary>'`.
 * Malformed lines are skipped so a partially rendered template never breaks the view.
 */
export function parseAnnotationOutput(output: string): LineAnnotation[] {
    const annotations: LineAnnotation[] = [];
    for (const raw of output.split('\n')) {
        if (!raw) {
            continue;
        }
        const [lineText, commitId, shortCommitId, author, epochSeconds, summary] = raw.split('\t');
        const line = Number.parseInt(lineText ?? '', 10);
        if (!Number.isFinite(line) || line < 1 || !commitId) {
            continue;
        }
        const seconds = Number.parseInt(epochSeconds ?? '', 10);
        annotations.push({
            line,
            commitId,
            shortCommitId: shortCommitId || commitId.slice(0, 8),
            author: author ?? '',
            timestamp: Number.isFinite(seconds) ? seconds * 1000 : 0,
            summary: summary ?? '',
        });
    }
    return annotations;
}

/**
 * Formats an epoch timestamp the way `jj log` does ("13 minutes ago").
 *
 * Computed on every render: the annotation cache stores only the absolute timestamp, so a
 * tooltip can never keep showing a relative time frozen at cache time.
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
    if (!timestamp) {
        return '';
    }
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (seconds < 45) {
        return 'just now';
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    }
    if (days < 30) {
        const weeks = Math.floor(days / 7);
        return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
    }
    if (days < 365) {
        const months = Math.floor(days / 30);
        return `${months} ${months === 1 ? 'month' : 'months'} ago`;
    }
    const years = Math.floor(days / 365);
    return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** Builds the single-line blame text rendered at the end of the editor line. */
export function formatLineBlameText(
    annotation: LineAnnotation | undefined,
    options: FormatLineBlameOptions = {},
): string | undefined {
    if (!annotation) {
        return undefined;
    }
    if (options.uncommitted) {
        return 'Uncommitted';
    }
    const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
    const ago = formatRelativeTime(annotation.timestamp, options.now);
    const text = [annotation.author, ago, annotation.summary].filter((part) => part.length > 0).join(' · ');
    if (!text) {
        return undefined;
    }
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/** One hover tooltip, in the order every tooltip must follow. */
interface HoverBlock {
    /** `author · time` plus the optional Line History link. */
    header?: string;
    /** Quoted, icon-prefixed block (`> ⚠️ …`), shown above the diff. */
    notice?: string;
    diff?: LineChange;
    message?: string;
}

/**
 * Renders a tooltip with a fixed order: header → notice → diff → rule → message.
 *
 * Committed and uncommitted hovers share this so their paragraphs always line up, and the
 * commit message can never be mistaken for part of the diff explanation.
 */
function formatHoverBlock(block: HoverBlock): string {
    const sections: string[][] = [];
    if (block.header) {
        sections.push([block.header]);
    }
    if (block.notice) {
        sections.push([block.notice]);
    }
    if (block.diff) {
        sections.push(formatDiffLines(block.diff));
    }
    if (block.diff && block.message) {
        sections.push(['---']);
    }
    if (block.message) {
        sections.push([block.message]);
    }
    return joinSections(sections);
}

/**
 * Builds the multi-line Markdown tooltip shown when hovering the annotated line:
 * `author · time · Line History`, an optional invisible-difference notice, the line diff,
 * then the complete commit message.
 */
export function formatHoverMarkdown(
    annotation: LineAnnotation,
    details?: CommitDetails,
    diff?: LineChange,
    lineHistoryLink?: string,
    now: number = Date.now(),
): string {
    const header = annotationHeader(annotation.author, formatRelativeTime(annotation.timestamp, now));
    return formatHoverBlock({
        header: lineHistoryLink ? `${header} · ${lineHistoryLink}` : header,
        notice: diff && isInvisibleOnly(diff) ? invisibleNotice() : undefined,
        diff,
        message: resolveDescription(details, annotation.summary),
    });
}

/**
 * True when the annotation belongs to the working-copy commit, i.e. the line was modified
 * after the last commit. `jj file annotate -r @` attributes such lines to `@`.
 */
export function isUncommittedLine(annotation: LineAnnotation, workingCopyCommitId: string | undefined): boolean {
    return !!workingCopyCommitId && annotation.commitId === workingCopyCommitId;
}

/**
 * Tooltip for an uncommitted line: states that the line is uncommitted, shows the working-copy
 * diff of that line, then the last committed annotation and message (omitted for added lines).
 */
export function formatUncommittedHoverMarkdown(
    parent: LineAnnotation | undefined,
    details?: CommitDetails,
    diff?: LineChange,
    lineHistoryLink?: string,
    now: number = Date.now(),
): string {
    // Header first, exactly like the committed tooltip: the last committed author/time owns
    // the line being edited. For a brand-new line there is no author, only the link.
    const header = parent ? annotationHeader(parent.author, formatRelativeTime(parent.timestamp, now)) : undefined;
    return formatHoverBlock({
        header: header && lineHistoryLink ? `${header} · ${lineHistoryLink}` : (header ?? lineHistoryLink),
        notice: '> ⚠️ **Uncommitted changes**',
        diff,
        message: parent ? resolveDescription(details, parent.summary) : undefined,
    });
}

/** Minimal shape of a parsed unified-diff chunk (structurally compatible with parse-diff). */
export interface DiffChunkLike {
    oldStart: number;
    newStart: number;
    changes: readonly { type: string; content: string }[];
}

/** Single-line change shown in the hover tooltip. */
export interface LineChange {
    /** Previous content of the line (undefined for a newly added line). */
    before?: string;
    /** Current content of the line. */
    after: string;
    /** True when the two sides differ only in trailing invisible characters. */
    invisibleOnly?: boolean;
}

/**
 * Picks the change for a 1-based line of the new file out of parsed diff chunks.
 * Returns undefined when the line is unchanged (context line) or outside every hunk.
 */
export function pickLineChange(chunks: readonly DiffChunkLike[], newLine: number): LineChange | undefined {
    for (const chunk of chunks) {
        let newLineNo = chunk.newStart;
        // Deletions are only paired with the additions of the same contiguous block: a `del`
        // from an earlier block must not end up as the "-" side of a later `+` line.
        let pendingBefore: string[] = [];
        for (const change of chunk.changes) {
            const content = change.content.slice(1);
            if (change.type === 'del') {
                pendingBefore.push(content);
                continue;
            }
            if (change.type === 'add') {
                const before = pendingBefore.shift();
                if (newLineNo === newLine) {
                    return { before, after: content };
                }
                newLineNo++;
                continue;
            }
            pendingBefore = [];
            if (newLineNo === newLine) {
                return undefined;
            }
            newLineNo++;
        }
    }
    return undefined;
}

const MAX_DIFF_LINE_LENGTH = 200;

function annotationHeader(author: string, ago: string): string {
    return ago ? `**${author}** · ${ago}` : `**${author}**`;
}

const INVISIBLE_NOTICE =
    '> ⚠️ **Notice** — the two lines differ in characters that are not visible here (line endings or trailing spaces).';

/**
 * A CRLF rewrite is a real change: the diff stays visible. When the parser dropped the
 * invisible characters it can look like the same line twice, so the caller adds a notice.
 */
function isInvisibleOnly(diff: LineChange): boolean {
    return diff.before !== undefined && (diff.before === diff.after || differsOnlyInvisibly(diff.before, diff.after));
}

function invisibleNotice(): string {
    return INVISIBLE_NOTICE;
}

/** The diff fence only; notices and separators are handled by `formatHoverBlock`. */
function formatDiffLines(diff: LineChange): string[] {
    const lines = ['```diff'];
    if (diff.before !== undefined) {
        lines.push(`- ${clipDiffLine(diff.before)}`);
    }
    lines.push(`+ ${clipDiffLine(diff.after)}`);
    lines.push('```');
    return lines;
}

function clipDiffLine(text: string): string {
    return text.length > MAX_DIFF_LINE_LENGTH ? `${text.slice(0, MAX_DIFF_LINE_LENGTH - 1)}…` : text;
}

function resolveDescription(details: CommitDetails | undefined, summary: string | undefined): string {
    return (details?.description ?? summary ?? '').trim() || '(no commit message)';
}

function joinSections(sections: readonly string[][]): string {
    return sections.map((section) => section.join('\n')).join('\n\n');
}

/** Finds the annotation for a 0-based editor line. */
export function findAnnotation(
    annotations: readonly LineAnnotation[] | undefined,
    zeroBasedLine: number,
): LineAnnotation | undefined {
    if (!annotations || annotations.length === 0) {
        return undefined;
    }
    const target = zeroBasedLine + 1;
    if (target < 1 || target > annotations.length) {
        return undefined;
    }
    const candidate = annotations[target - 1];
    return candidate?.line === target ? candidate : annotations.find((entry) => entry.line === target);
}

/**
 * Cache key including a signature of the file content (`jj file annotate` reads the file
 * on disk, so an unsaved edit must not invalidate the annotations) and the working-copy
 * commit id (new commits / bookmark advances swap `@` without touching the document, so
 * the annotations must be re-read).
 */
export function lineBlameCacheKey(
    repoRoot: string,
    fsPath: string,
    contentSignature: string | number,
    workingCopyCommitId: string | undefined,
): string {
    return `${repoRoot}|${fsPath}|${contentSignature}|${workingCopyCommitId ?? ''}`;
}
