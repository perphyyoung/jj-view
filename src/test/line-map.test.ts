/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { buildBufferToCommitLineMap } from '../core/blame/line-map';

describe('buildBufferToCommitLineMap', () => {
    it('maps lines when lines were inserted above', () => {
        const commitLines = ['a', 'b', 'c'];
        const bufferLines = ['x', 'y', 'a', 'b', 'c'];
        const map = buildBufferToCommitLineMap(commitLines, bufferLines);
        expect(map.get(2)).toBe(0);
        expect(map.get(3)).toBe(1);
        expect(map.get(4)).toBe(2);
        expect(map.size).toBe(3);
    });

    it('maps lines when lines were removed above', () => {
        const commitLines = ['x', 'y', 'a', 'b'];
        const bufferLines = ['a', 'b'];
        const map = buildBufferToCommitLineMap(commitLines, bufferLines);
        expect(map.get(0)).toBe(2);
        expect(map.get(1)).toBe(3);
    });

    it('leaves rewritten lines unmapped', () => {
        const commitLines = ['a', 'b', 'c'];
        const bufferLines = ['a', 'B', 'c'];
        const map = buildBufferToCommitLineMap(commitLines, bufferLines);
        expect(map.get(0)).toBe(0);
        expect(map.has(1)).toBe(false);
        expect(map.get(2)).toBe(2);
    });

    it('maps unchanged prefix when lines were appended', () => {
        const commitLines = ['a'];
        const bufferLines = ['a', 'b', 'c'];
        const map = buildBufferToCommitLineMap(commitLines, bufferLines);
        expect(map.get(0)).toBe(0);
        expect(map.size).toBe(1);
    });

    it('handles an empty committed file', () => {
        const map = buildBufferToCommitLineMap([], ['a', 'b']);
        expect(map.size).toBe(0);
    });

    it('maps identical files one to one', () => {
        const lines = ['a', 'b', 'c', 'd'];
        const map = buildBufferToCommitLineMap(lines, lines);
        for (let line = 0; line < lines.length; line++) {
            expect(map.get(line)).toBe(line);
        }
    });
});
