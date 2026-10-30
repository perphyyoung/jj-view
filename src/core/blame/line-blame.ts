/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
    /** Relative time reported by jj, e.g. "1 day ago". */
    ago: string;
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
}

const DEFAULT_MAX_LENGTH = 100;

/**
 * Parses `jj file annotate -T '<line>\t<commit>\t<short>\t<author>\t<ago>\t<summary>'`.
 * Malformed lines are skipped so a partially rendered template never breaks the view.
 */
export function parseAnnotationOutput(output: string): LineAnnotation[] {
    const annotations: LineAnnotation[] = [];
    for (const raw of output.split('\n')) {
        if (!raw) {
            continue;
        }
        const [lineText, commitId, shortCommitId, author, ago, summary] = raw.split('\t');
        const line = Number.parseInt(lineText ?? '', 10);
        if (!Number.isFinite(line) || line < 1 || !commitId) {
            continue;
        }
        annotations.push({
            line,
            commitId,
            shortCommitId: shortCommitId || commitId.slice(0, 8),
            author: author ?? '',
            ago: ago ?? '',
            summary: summary ?? '',
        });
    }
    return annotations;
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
    const text = [annotation.author, annotation.ago, annotation.summary].filter((part) => part.length > 0).join(' · ');
    if (!text) {
        return undefined;
    }
    return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/**
 * Builds the multi-line Markdown tooltip shown when hovering the annotated line:
 * a single "author · relative time" header followed by the complete commit message.
 */
export function formatHoverMarkdown(annotation: LineAnnotation, details?: CommitDetails, diff?: LineChange): string {
    const sections: string[][] = [[annotationHeader(annotation.author, annotation.ago)]];
    if (diff) {
        sections.push(formatDiffBlock(diff));
    }
    sections.push([resolveDescription(details, annotation.summary)]);
    return joinSections(sections);
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
): string {
    const sections: string[][] = [['**Uncommitted changes**']];
    if (diff) {
        sections.push(formatDiffBlock(diff));
    }
    if (parent) {
        sections.push([annotationHeader(parent.author, parent.ago)]);
        sections.push([resolveDescription(details, parent.summary)]);
    }
    return joinSections(sections);
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
}

/**
 * Picks the change for a 1-based line of the new file out of parsed diff chunks.
 * Returns undefined when the line is unchanged (context line) or outside every hunk.
 */
export function pickLineChange(chunks: readonly DiffChunkLike[], newLine: number): LineChange | undefined {
    for (const chunk of chunks) {
        let newLineNo = chunk.newStart;
        const pendingBefore: string[] = [];
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

function formatDiffBlock(diff: LineChange): string[] {
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
 * Cache key including the document version (edits invalidate the annotations) and the
 * working-copy commit id (new commits / bookmark advances swap `@` without touching the
 * document, so the annotations must be re-read).
 */
export function lineBlameCacheKey(
    repoRoot: string,
    fsPath: string,
    documentVersion: number,
    workingCopyCommitId: string | undefined,
): string {
    return `${repoRoot}|${fsPath}|${documentVersion}|${workingCopyCommitId ?? ''}`;
}
