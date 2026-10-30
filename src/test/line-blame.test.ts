/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
    findAnnotation,
    formatHoverMarkdown,
    formatLineBlameText,
    formatUncommittedHoverMarkdown,
    isUncommittedLine,
    lineBlameCacheKey,
    parseAnnotationOutput,
    pickLineChange,
} from '../core/blame/line-blame';

describe('parseAnnotationOutput', () => {
    it('parses tab-separated annotate rows', () => {
        const output = [
            '1\tabcdef123456\tabcdef12\tperphyyoung\t1 day ago\tinitial commit',
            '2\tabcdef123456\tabcdef12\tperphyyoung\t1 day ago\tinitial commit',
            '3\t999999999999\t99999999\talice\t2 hours ago\tfix upload',
        ].join('\n');

        expect(parseAnnotationOutput(output)).toEqual([
            {
                line: 1,
                commitId: 'abcdef123456',
                shortCommitId: 'abcdef12',
                author: 'perphyyoung',
                ago: '1 day ago',
                summary: 'initial commit',
            },
            {
                line: 2,
                commitId: 'abcdef123456',
                shortCommitId: 'abcdef12',
                author: 'perphyyoung',
                ago: '1 day ago',
                summary: 'initial commit',
            },
            {
                line: 3,
                commitId: '999999999999',
                shortCommitId: '99999999',
                author: 'alice',
                ago: '2 hours ago',
                summary: 'fix upload',
            },
        ]);
    });

    it('skips malformed rows', () => {
        const output = [
            'not-a-number\tabc\tdef\tauthor\tago\tsummary',
            '',
            '2\tabc\t\t\t\t',
            '3\txyz\txyz\tbob\t3 days ago\tdone',
        ].join('\n');

        const annotations = parseAnnotationOutput(output);
        expect(annotations).toHaveLength(2);
        expect(annotations[0]).toMatchObject({ line: 2, commitId: 'abc', ago: '', summary: '' });
        expect(annotations[1]).toMatchObject({ line: 3, author: 'bob', ago: '3 days ago', summary: 'done' });
    });

    it('derives a short id when the template omits it', () => {
        const annotations = parseAnnotationOutput('1\t0123456789abcdef\t\tauthor\tnow\tsummary');
        expect(annotations[0].shortCommitId).toBe('01234567');
    });

    it('returns an empty array for empty output', () => {
        expect(parseAnnotationOutput('')).toEqual([]);
    });
});

describe('formatLineBlameText', () => {
    const annotation = {
        line: 1,
        commitId: 'abcdef123456',
        shortCommitId: 'abcdef12',
        author: 'perphyyoung',
        ago: '1 day ago',
        summary: 'fix upload stack',
    };

    it('renders author, relative time and summary', () => {
        expect(formatLineBlameText(annotation)).toBe('perphyyoung · 1 day ago · fix upload stack');
    });

    it('omits empty parts', () => {
        expect(formatLineBlameText({ ...annotation, ago: '' })).toBe('perphyyoung · fix upload stack');
        expect(formatLineBlameText({ ...annotation, summary: '' })).toBe('perphyyoung · 1 day ago');
    });

    it('truncates long text', () => {
        const text = formatLineBlameText(
            { ...annotation, author: 'a'.repeat(50), ago: '9'.repeat(50) },
            { maxLength: 20 },
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
        ago: '1 day ago',
        summary: 'feat: 默认本地化运行并收敛刷新链路',
    };

    it('keeps author and time on one line, then the complete message only', () => {
        const markdown = formatHoverMarkdown(annotation, {
            description: 'feat: 默认本地化运行并收敛刷新链路\n\n- 第二个段落',
        });

        expect(markdown.startsWith('**py** · 1 day ago\n\n')).toBe(true);
        expect(markdown).toContain('- 第二个段落');
        expect(markdown).not.toContain('py@pc.com');
        expect(markdown).not.toContain('e7169b517724fe374d04cb5633c987e80b608f70');
    });

    it('falls back to the summary when full details are unavailable', () => {
        expect(formatHoverMarkdown(annotation)).toBe('**py** · 1 day ago\n\nfeat: 默认本地化运行并收敛刷新链路');
    });

    it('shows a placeholder when the commit has no message', () => {
        expect(formatHoverMarkdown({ ...annotation, summary: '' })).toBe('**py** · 1 day ago\n\n(no commit message)');
    });
});

describe('isUncommittedLine', () => {
    const annotation = {
        line: 1,
        commitId: 'wc-commit',
        shortCommitId: 'wc-commi',
        author: 'py',
        ago: 'now',
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
        ago: '2 days ago',
        summary: 'previous message',
    };

    it('states the uncommitted state and shows the last committed annotation', () => {
        const markdown = formatUncommittedHoverMarkdown(parent, { description: 'previous message\n\nbody' });

        expect(markdown.startsWith('**Uncommitted changes**\n\n**alice** · 2 days ago\n\n')).toBe(true);
        expect(markdown).toContain('body');
    });

    it('falls back to the parent summary without full details', () => {
        expect(formatUncommittedHoverMarkdown(parent)).toBe(
            '**Uncommitted changes**\n\n**alice** · 2 days ago\n\nprevious message',
        );
    });

    it('shows a placeholder when the parent commit has no message', () => {
        expect(formatUncommittedHoverMarkdown({ ...parent, summary: '' })).toBe(
            '**Uncommitted changes**\n\n**alice** · 2 days ago\n\n(no commit message)',
        );
    });

    it('omits the committed section for newly added lines', () => {
        expect(formatUncommittedHoverMarkdown(undefined)).toBe('**Uncommitted changes**');
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
        ago: '1 day ago',
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
        const parent = { ...annotation, author: 'alice', ago: '2 days ago', summary: 'previous' };
        const markdown = formatUncommittedHoverMarkdown(
            parent,
            { description: 'previous' },
            { before: 'x', after: 'y' },
        );

        expect(markdown.startsWith('**Uncommitted changes**')).toBe(true);
        expect(markdown).toContain('- x');
        expect(markdown).toContain('+ y');
    });
});

describe('findAnnotation', () => {
    const annotations = [
        { line: 1, commitId: 'a', shortCommitId: 'a', author: 'a', ago: '', summary: '' },
        { line: 2, commitId: 'b', shortCommitId: 'b', author: 'b', ago: '', summary: '' },
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
