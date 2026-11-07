/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
    buildLineHistoryArgs,
    clipDetail,
    extractLineTexts,
    hasMoreEntries,
    LINE_HISTORY_PAGE_SIZE,
    parseLineHistoryOutput,
    shortSha,
    sliceLineHistoryPage,
} from '../core/blame/line-history';

const entry = (n: number) => ({
    sha: `${n}`.padStart(40, 'a'),
    author: `author${n}`,
    date: '2026-11-07T10:00:00+08:00',
    summary: `commit ${n}`,
});

describe('buildLineHistoryArgs', () => {
    it('targets one line with --no-patch and an explicit revision', () => {
        const args = buildLineHistoryArgs({
            gitDir: '/repo/.git',
            filePath: 'src/a.ts',
            line: 42,
            startSha: 'deadbeef',
            limit: 10,
        });

        expect(args).toContain('--git-dir=/repo/.git');
        expect(args).toContain('42,42:src/a.ts');
        expect(args[args.length - 1]).toBe('deadbeef');
        expect(args[args.indexOf('-n') + 1]).toBe('10');
    });

    it('emits NUL separators via the format escape', () => {
        const args = buildLineHistoryArgs({
            gitDir: '.git',
            filePath: 'f.txt',
            line: 1,
            startSha: 'abc',
        });
        const format = args.find((arg) => arg.startsWith('--format='));
        // A literal NUL cannot be passed in argv, so git's %x00 escape must be used.
        expect(format).toContain('%x00');
    });
});

describe('parseLineHistoryOutput', () => {
    it('parses one entry per line', () => {
        const stdout = [
            `sha1\u0000Alice\u00002026-11-01T10:00:00+08:00\u0000first`,
            `sha2\u0000Bob\u00002026-11-02T10:00:00+08:00\u0000second`,
        ].join('\n');

        expect(parseLineHistoryOutput(stdout)).toEqual([
            { sha: 'sha1', author: 'Alice', date: '2026-11-01T10:00:00+08:00', summary: 'first' },
            { sha: 'sha2', author: 'Bob', date: '2026-11-02T10:00:00+08:00', summary: 'second' },
        ]);
    });

    it('keeps a commit message that contains the separator', () => {
        const stdout = `sha\u0000Alice\u00002026-11-01T10:00:00Z\u0000title\u0000body`;
        expect(parseLineHistoryOutput(stdout)[0].summary).toBe('title\u0000body');
    });

    it('ignores empty and malformed lines', () => {
        expect(parseLineHistoryOutput('\nnot-a-commit\n')).toEqual([]);
    });
});

describe('paging', () => {
    it('slices the first page and reports the remainder', () => {
        const entries = Array.from({ length: 12 }, (_, i) => entry(i));
        const page = sliceLineHistoryPage(entries, 0);

        expect(page.entries).toHaveLength(LINE_HISTORY_PAGE_SIZE);
        expect(page.hasMore).toBe(true);
        expect(page.remaining).toBe(2);
    });

    it('returns the rest without more when the list ends', () => {
        const entries = Array.from({ length: 12 }, (_, i) => entry(i));
        const page = sliceLineHistoryPage(entries, LINE_HISTORY_PAGE_SIZE);

        expect(page.entries).toHaveLength(2);
        expect(page.hasMore).toBe(false);
        expect(page.remaining).toBe(0);
    });

    it('exactly fills one page without a load-more item', () => {
        const entries = Array.from({ length: LINE_HISTORY_PAGE_SIZE }, (_, i) => entry(i));
        expect(hasMoreEntries(entries.length, LINE_HISTORY_PAGE_SIZE)).toBe(false);
    });
});

describe('extractLineTexts', () => {
    const meta = (sha: string, summary: string) => [sha, 'Alice', '2026-11-01T10:00:00+08:00', summary].join('\u0000');

    it('reads the tracked line from a replacement hunk', () => {
        const stdout = [
            meta('a'.repeat(40), 'second'),
            'diff --git a/f.txt b/f.txt',
            '@@ -1,3 +1,3 @@',
            ' a',
            '-old',
            '+new',
            ' c',
        ].join('\n');

        expect(extractLineTexts(stdout, 2).get('a'.repeat(40))).toBe('new');
    });

    it('follows the line number back through insertions above it', () => {
        const shaA = 'a'.repeat(40);
        const shaB = 'b'.repeat(40);
        const stdout = [
            meta(shaA, 'third'),
            '@@ -1,2 +1,3 @@',
            ' x',
            '+inserted',
            '-old3',
            '+new3',
            meta(shaB, 'second'),
            '@@ -1,2 +1,2 @@',
            ' x',
            '-parent',
            '+old3',
        ].join('\n');

        const texts = extractLineTexts(stdout, 3);
        expect(texts.get(shaA)).toBe('new3');
        expect(texts.get(shaB)).toBe('old3');
    });

    it('strips a trailing CR before showing the text', () => {
        const sha = 'c'.repeat(40);
        const stdout = [meta(sha, 'crlf'), '@@ -1 +1 @@', '-old\r', '+new\r'].join('\n');
        expect(extractLineTexts(stdout, 1).get(sha)).toBe('new\r');
    });

    it('returns an empty map when the output has no patch', () => {
        const sha = 'd'.repeat(40);
        expect(extractLineTexts(meta(sha, 'metadata only'), 1).size).toBe(0);
    });
});

describe('clipDetail', () => {
    it('keeps short text as-is', () => {
        expect(clipDetail('"version": "0.2.6",')).toBe('"version": "0.2.6",');
    });

    it('truncates long text with an ellipsis', () => {
        const long = 'x'.repeat(120);
        const clipped = clipDetail(long);
        expect(clipped).toHaveLength(100);
        expect(clipped.endsWith('…')).toBe(true);
    });

    it('drops a trailing CR', () => {
        expect(clipDetail('value 1\r')).toBe('value 1');
    });
});

describe('shortSha', () => {
    it('keeps eight characters', () => {
        expect(shortSha('0123456789abcdef')).toBe('01234567');
    });
});
