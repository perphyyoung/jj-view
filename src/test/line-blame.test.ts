/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
    findAnnotation,
    formatHoverMarkdown,
    formatLineBlameText,
    formatRelativeTime,
    formatUncommittedHoverMarkdown,
    isUncommittedLine,
    lineBlameCacheKey,
    parseAnnotationOutput,
    pickLineChange,
} from '../core/blame/line-blame';

/** Fixed clock: relative labels must be deterministic in tests. */
const NOW = Date.parse('2026-11-08T12:00:00Z');
const minutesAgo = (n: number): number => NOW - n * 60_000;
const daysAgo = (n: number): number => NOW - n * 86_400_000;
const seconds = (ms: number): string => String(Math.floor(ms / 1000));

describe('parseAnnotationOutput', () => {
    it('parses tab-separated annotate rows with an absolute committer time', () => {
        const day = seconds(daysAgo(1));
        const output = [
            `1\tabcdef123456\tabcdef12\tperphyyoung\t${day}\tinitial commit`,
            `2\tabcdef123456\tabcdef12\tperphyyoung\t${day}\tinitial commit`,
            `3\t999999999999\t99999999\talice\t${seconds(minutesAgo(120))}\tfix upload`,
        ].join('\n');

        expect(parseAnnotationOutput(output)).toEqual([
            {
                line: 1,
                commitId: 'abcdef123456',
                shortCommitId: 'abcdef12',
                author: 'perphyyoung',
                timestamp: daysAgo(1),
                summary: 'initial commit',
            },
            {
                line: 2,
                commitId: 'abcdef123456',
                shortCommitId: 'abcdef12',
                author: 'perphyyoung',
                timestamp: daysAgo(1),
                summary: 'initial commit',
            },
            {
                line: 3,
                commitId: '999999999999',
                shortCommitId: '99999999',
                author: 'alice',
                timestamp: minutesAgo(120),
                summary: 'fix upload',
            },
        ]);
    });

    it('skips malformed rows', () => {
        const output = [
            'not-a-number\tabc\tdef\tauthor\tago\tsummary',
            '',
            '2\tabc\t\t\t\t',
            `3\txyz\txyz\tbob\t${seconds(daysAgo(3))}\tdone`,
        ].join('\n');

        const annotations = parseAnnotationOutput(output);
        expect(annotations).toHaveLength(2);
        expect(annotations[0]).toMatchObject({ line: 2, commitId: 'abc', timestamp: 0, summary: '' });
        expect(annotations[1]).toMatchObject({ line: 3, author: 'bob', timestamp: daysAgo(3), summary: 'done' });
    });

    it('derives a short id when the template omits it', () => {
        const annotations = parseAnnotationOutput(`1\t0123456789abcdef\t\tauthor\t${seconds(NOW)}\tsummary`);
        expect(annotations[0].shortCommitId).toBe('01234567');
    });

    it('returns an empty array for empty output', () => {
        expect(parseAnnotationOutput('')).toEqual([]);
    });
});

describe('formatRelativeTime', () => {
    it('matches jj log wording across buckets', () => {
        const at = (secondsAgo: number) => NOW - secondsAgo * 1000;
        expect(formatRelativeTime(at(10), NOW)).toBe('just now');
        expect(formatRelativeTime(at(60), NOW)).toBe('1 minute ago');
        expect(formatRelativeTime(at(13 * 60), NOW)).toBe('13 minutes ago');
        expect(formatRelativeTime(at(3600), NOW)).toBe('1 hour ago');
        expect(formatRelativeTime(at(2 * 3600), NOW)).toBe('2 hours ago');
        expect(formatRelativeTime(at(86_400), NOW)).toBe('1 day ago');
        expect(formatRelativeTime(at(2 * 86_400), NOW)).toBe('2 days ago');
        expect(formatRelativeTime(at(8 * 86_400), NOW)).toBe('1 week ago');
        expect(formatRelativeTime(at(31 * 86_400), NOW)).toBe('1 month ago');
        expect(formatRelativeTime(at(400 * 86_400), NOW)).toBe('1 year ago');
    });

    it('returns an empty label for an unknown timestamp', () => {
        expect(formatRelativeTime(0, NOW)).toBe('');
    });
});

describe('formatLineBlameText', () => {
    const annotation = {
        line: 1,
        commitId: 'abcdef123456',
        shortCommitId: 'abcdef12',
        author: 'perphyyoung',
        timestamp: daysAgo(1),
        summary: 'fix upload stack',
    };

    it('renders author, relative time and summary', () => {
        expect(formatLineBlameText(annotation, { now: NOW })).toBe('perphyyoung · 1 day ago · fix upload stack');
    });

    it('omits empty parts', () => {
        expect(formatLineBlameText({ ...annotation, timestamp: 0 }, { now: NOW })).toBe(
            'perphyyoung · fix upload stack',
        );
        expect(formatLineBlameText({ ...annotation, summary: '' }, { now: NOW })).toBe('perphyyoung · 1 day ago');
    });

    it('truncates long text', () => {
        const text = formatLineBlameText(
            { ...annotation, author: 'a'.repeat(50), summary: 'b'.repeat(50) },
            { maxLength: 20, now: NOW },
        );
        expect(text).toHaveLength(20);
        expect(text?.endsWith('…')).toBe(true);
    });

    it('renders Uncommitted for a working-copy line', () => {
        expect(formatLineBlameText(annotation, { uncommitted: true })).toBe('Uncommitted');
    });

    it('returns undefined without an annotation', () => {
        expect(formatLineBlameText(undefined)).toBeUndefined();
    });
});

describe('formatHoverMarkdown', () => {
    const annotation = {
        line: 1,
        commitId: 'e7169b517724fe374d04cb5633c987e80b608f70',
        shortCommitId: 'e7169b51',
        author: 'py',
        timestamp: daysAgo(1),
        summary: 'feat: 默认本地化运行并收敛刷新链路',
    };

    it('keeps author and time on one line, then the complete message only', () => {
        const markdown = formatHoverMarkdown(
            annotation,
            {
                description: 'feat: 默认本地化运行并收敛刷新链路\n\n- 第二个段落',
            },
            undefined,
            undefined,
            NOW,
        );

        expect(markdown.startsWith('**py** · 1 day ago\n\n')).toBe(true);
        expect(markdown).toContain('- 第二个段落');
        expect(markdown).not.toContain('py@pc.com');
        expect(markdown).not.toContain('e7169b517724fe374d04cb5633c987e80b608f70');
    });

    it('falls back to the summary when full details are unavailable', () => {
        expect(formatHoverMarkdown(annotation, undefined, undefined, undefined, NOW)).toBe(
            '**py** · 1 day ago\n\nfeat: 默认本地化运行并收敛刷新链路',
        );
    });

    it('shows a placeholder when the commit has no message', () => {
        expect(formatHoverMarkdown({ ...annotation, summary: '' }, undefined, undefined, undefined, NOW)).toBe(
            '**py** · 1 day ago\n\n(no commit message)',
        );
    });
});

describe('isUncommittedLine', () => {
    const annotation = {
        line: 1,
        commitId: 'wc-commit',
        shortCommitId: 'wc-commi',
        author: 'py',
        timestamp: NOW,
        summary: '',
    };

    it('matches the working-copy commit id', () => {
        expect(isUncommittedLine(annotation, 'wc-commit')).toBe(true);
        expect(isUncommittedLine(annotation, 'other')).toBe(false);
        expect(isUncommittedLine(annotation, undefined)).toBe(false);
    });
});

describe('formatUncommittedHoverMarkdown', () => {
    const parent = {
        line: 1,
        commitId: 'parent-commit',
        shortCommitId: 'parent-c',
        author: 'alice',
        timestamp: daysAgo(2),
        summary: 'previous message',
    };

    it('puts the last committed author and link first, then the notice', () => {
        const markdown = formatUncommittedHoverMarkdown(
            parent,
            { description: 'previous message\n\nbody' },
            undefined,
            '[Line History](command:jj-view.lineHistory?x)',
            NOW,
        );

        expect(markdown.startsWith('**alice** · 2 days ago · [Line History]')).toBe(true);
        expect(markdown.indexOf('**alice**')).toBeLessThan(markdown.indexOf('Uncommitted changes'));
        expect(markdown).toContain('body');
    });

    it('falls back to the parent summary without full details', () => {
        expect(formatUncommittedHoverMarkdown(parent, undefined, undefined, undefined, NOW)).toBe(
            '**alice** · 2 days ago\n\n> ⚠️ **Uncommitted changes**\n\nprevious message',
        );
    });

    it('shows a placeholder when the parent commit has no message', () => {
        expect(formatUncommittedHoverMarkdown({ ...parent, summary: '' }, undefined, undefined, undefined, NOW)).toBe(
            '**alice** · 2 days ago\n\n> ⚠️ **Uncommitted changes**\n\n(no commit message)',
        );
    });

    it('omits the committed section for newly added lines', () => {
        expect(formatUncommittedHoverMarkdown(undefined)).toBe('> ⚠️ **Uncommitted changes**');
    });

    it('follows header → notice → diff → rule → message', () => {
        const markdown = formatUncommittedHoverMarkdown(
            parent,
            undefined,
            { before: 'old', after: 'new' },
            '[Line History](command:jj-view.lineHistory?x)',
        );

        const order = [
            markdown.indexOf('**alice**'),
            markdown.indexOf('Uncommitted changes'),
            markdown.indexOf('```diff'),
            markdown.indexOf('---'),
            markdown.indexOf('previous message'),
        ];
        expect(order.every((value) => value >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('omits the rule when there is no diff', () => {
        const markdown = formatUncommittedHoverMarkdown(parent);
        expect(markdown).not.toContain('---');
    });

    it('keeps only the link as the header for a brand-new line', () => {
        const markdown = formatUncommittedHoverMarkdown(
            undefined,
            undefined,
            { before: undefined, after: 'new' },
            '[Line History](command:jj-view.lineHistory?x)',
        );

        expect(markdown.startsWith('[Line History](command:jj-view.lineHistory?x)\n\n> ⚠️')).toBe(true);
        expect(markdown).not.toContain('---');
    });
});

describe('pickLineChange', () => {
    const replacementChunk = {
        oldStart: 5,
        newStart: 5,
        changes: [
            { type: 'normal', content: ' line5' },
            { type: 'del', content: '-    "version": "3.0.4",' },
            { type: 'add', content: '+    "version": "3.0.5",' },
            { type: 'normal', content: ' line7' },
        ],
    };

    it('returns before/after for a replaced line', () => {
        expect(pickLineChange([replacementChunk], 6)).toEqual({
            before: '    "version": "3.0.4",',
            after: '    "version": "3.0.5",',
        });
    });

    it('keeps a CRLF-only pair so the tooltip can mark the difference', () => {
        const crlfChunk = {
            oldStart: 1,
            newStart: 1,
            changes: [
                { type: 'del', content: '-  "version": "0.2.6",\r' },
                { type: 'add', content: '+  "version": "0.2.6",' },
            ],
        };

        expect(pickLineChange([crlfChunk], 1)).toEqual({
            before: '  "version": "0.2.6",\r',
            after: '  "version": "0.2.6",',
        });
    });

    it('explains why two lines that look alike still differ', () => {
        const markdown = formatHoverMarkdown(
            { line: 1, commitId: 'c1', shortCommitId: 'c1', author: 'py', timestamp: daysAgo(1), summary: 's' },
            undefined,
            // jj's diff output drops the CR, so both sides arrive identical here.
            { before: '  "version": "0.2.6",', after: '  "version": "0.2.6",' },
        );

        expect(markdown).toContain('characters that are not visible here');
        // The diff block itself must stay: the change is real, only the cause is invisible.
        expect(markdown).toContain('```diff');
        // Notice sits above the diff, is visually distinct, and is separated from the message.
        expect(markdown.indexOf('**Notice**')).toBeLessThan(markdown.indexOf('```diff'));
        expect(markdown).toContain('⚠️');
        expect(markdown).toContain('\n---\n');
    });

    it('does not add the note for a normal change', () => {
        const markdown = formatHoverMarkdown(
            { line: 1, commitId: 'c1', shortCommitId: 'c1', author: 'py', timestamp: daysAgo(1), summary: 's' },
            undefined,
            { before: 'old', after: 'new' },
        );

        expect(markdown).not.toContain('characters that are not visible here');
    });

    it('returns only the added side for a new line', () => {
        const addedChunk = {
            oldStart: 1,
            newStart: 1,
            changes: [
                { type: 'normal', content: ' a' },
                { type: 'add', content: '+b' },
            ],
        };

        expect(pickLineChange([addedChunk], 2)).toEqual({ before: undefined, after: 'b' });
    });

    it('does not pair a deletion from an earlier block with a later addition', () => {
        const mixedChunk = {
            oldStart: 1,
            newStart: 1,
            changes: [
                { type: 'del', content: '-old line' },
                { type: 'normal', content: ' context' },
                { type: 'add', content: '+added line' },
            ],
        };

        // Line 2 is the addition; the deletion above belongs to another block.
        expect(pickLineChange([mixedChunk], 2)).toEqual({ before: undefined, after: 'added line' });
    });

    it('returns undefined for an unchanged (context) line', () => {
        expect(pickLineChange([replacementChunk], 5)).toBeUndefined();
        expect(pickLineChange([replacementChunk], 7)).toBeUndefined();
    });

    it('returns undefined outside every hunk', () => {
        expect(pickLineChange([replacementChunk], 100)).toBeUndefined();
        expect(pickLineChange([], 1)).toBeUndefined();
    });
});

describe('hover markdown with line diff', () => {
    const annotation = {
        line: 1,
        commitId: 'abc',
        shortCommitId: 'abc',
        author: 'py',
        timestamp: daysAgo(1),
        summary: 'version bump',
    };

    it('places the diff between the header and the message', () => {
        const markdown = formatHoverMarkdown(
            annotation,
            { description: 'version bump' },
            { before: 'old', after: 'new' },
        );

        expect(markdown).toContain('```diff');
        expect(markdown).toContain('- old');
        expect(markdown).toContain('+ new');
        expect(markdown.indexOf('**py**')).toBeLessThan(markdown.indexOf('```diff'));
        expect(markdown.indexOf('```diff')).toBeLessThan(markdown.indexOf('version bump'));
    });

    it('includes the working-copy diff for uncommitted lines', () => {
        const parent = { ...annotation, author: 'alice', timestamp: daysAgo(2), summary: 'previous' };
        const markdown = formatUncommittedHoverMarkdown(
            parent,
            { description: 'previous' },
            { before: 'x', after: 'y' },
            undefined,
            NOW,
        );

        expect(markdown.startsWith('**alice** · 2 days ago')).toBe(true);
        expect(markdown).toContain('> ⚠️ **Uncommitted changes**');
        expect(markdown).toContain('- x');
        expect(markdown).toContain('+ y');
    });
});

describe('findAnnotation', () => {
    const annotations = [
        { line: 1, commitId: 'a', shortCommitId: 'a', author: 'a', timestamp: 0, summary: '' },
        { line: 2, commitId: 'b', shortCommitId: 'b', author: 'b', timestamp: 0, summary: '' },
    ];

    it('maps a 0-based editor line to the 1-based annotation', () => {
        expect(findAnnotation(annotations, 0)?.commitId).toBe('a');
        expect(findAnnotation(annotations, 1)?.commitId).toBe('b');
    });

    it('returns undefined outside the annotated range', () => {
        expect(findAnnotation(annotations, 2)).toBeUndefined();
        expect(findAnnotation(annotations, -1)).toBeUndefined();
        expect(findAnnotation(undefined, 0)).toBeUndefined();
        expect(findAnnotation([], 0)).toBeUndefined();
    });
});

describe('lineBlameCacheKey', () => {
    it('includes repository, file, document version and working-copy commit', () => {
        expect(lineBlameCacheKey('D:/repo', 'D:/repo/a.ts', 7, 'abc123')).toBe('D:/repo|D:/repo/a.ts|7|abc123');
    });

    it('changes when the working-copy commit is swapped', () => {
        expect(lineBlameCacheKey('D:/repo', 'D:/repo/a.ts', 7, 'old')).not.toBe(
            lineBlameCacheKey('D:/repo', 'D:/repo/a.ts', 7, 'new'),
        );
    });

    it('tolerates a missing working-copy commit', () => {
        expect(lineBlameCacheKey('D:/repo', 'D:/repo/a.ts', 7, undefined)).toBe('D:/repo|D:/repo/a.ts|7|');
    });
});
