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
export function formatHoverMarkdown(annotation: LineAnnotation, details?: CommitDetails): string {
    const header = annotation.ago ? `**${annotation.author}** · ${annotation.ago}` : `**${annotation.author}**`;
    const description = (details?.description ?? annotation.summary ?? '').trim();
    return description.length > 0 ? `${header}\n\n${description}` : header;
}

/**
 * True when the annotation belongs to the working-copy commit, i.e. the line was modified
 * after the last commit. `jj file annotate -r @` attributes such lines to `@`.
 */
export function isUncommittedLine(annotation: LineAnnotation, workingCopyCommitId: string | undefined): boolean {
    return !!workingCopyCommitId && annotation.commitId === workingCopyCommitId;
}

/**
 * Tooltip for an uncommitted line: states that the line is uncommitted, then shows the last
 * committed annotation of the same line and its full message (omitted for newly added lines).
 */
export function formatUncommittedHoverMarkdown(parent: LineAnnotation | undefined, details?: CommitDetails): string {
    const header = '**Uncommitted changes**';
    if (!parent) {
        return header;
    }
    const parentHeader = parent.ago ? `**${parent.author}** · ${parent.ago}` : `**${parent.author}**`;
    const description = (details?.description ?? parent.summary ?? '').trim();
    return description.length > 0 ? `${header}\n\n${parentHeader}\n\n${description}` : `${header}\n\n${parentHeader}`;
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

/** Cache key including the document version so edits invalidate the annotations. */
export function lineBlameCacheKey(repoRoot: string, fsPath: string, documentVersion: number): string {
    return `${repoRoot}|${fsPath}|${documentVersion}`;
}
