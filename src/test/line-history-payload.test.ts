/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizeLineHistoryPayload } from '../core/commands/line-history';

describe('normalizeLineHistoryPayload', () => {
    it('keeps the hover link shape', () => {
        expect(normalizeLineHistoryPayload({ root: '/repo', path: 'src/a.ts', line: 7 }, {}, '/repo')).toEqual({
            root: '/repo',
            path: 'src/a.ts',
            line: 7,
        });
    });

    it('accepts the editor context shape and converts lineNumber to a 1-based line', () => {
        expect(normalizeLineHistoryPayload({ fileName: '/repo/a.ts', lineNumber: 2 }, {}, '/repo')).toEqual({
            root: '/repo',
            fileName: '/repo/a.ts',
            lineNumber: 2,
        });
    });

    it('falls back to the active editor when the menu passes no usable argument', () => {
        expect(normalizeLineHistoryPayload(undefined, { fileName: '/repo/a.ts', lineNumber: 4 }, '/repo')).toEqual({
            root: '/repo',
            fileName: '/repo/a.ts',
            lineNumber: 4,
        });
    });

    it('falls back when only a URI was passed', () => {
        expect(
            normalizeLineHistoryPayload({ fsPath: '/repo/a.ts' }, { fileName: '/repo/a.ts', lineNumber: 0 }, '/repo'),
        ).toEqual({ root: '/repo', fileName: '/repo/a.ts', lineNumber: 0 });
    });

    it('returns undefined when there is no file at all', () => {
        expect(normalizeLineHistoryPayload(undefined, {}, '/repo')).toBeUndefined();
    });

    it('ignores invalid line numbers', () => {
        const payload = normalizeLineHistoryPayload({ fileName: '/repo/a.ts', line: 0, lineNumber: -1 });
        expect(payload?.line).toBeUndefined();
        expect(payload?.lineNumber).toBeUndefined();
    });
});
