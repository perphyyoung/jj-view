/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getNestedRepositoryIgnoreGlobs, isNestedRepositoryMetadataPath } from '../core/change-detection-manager';

describe('nested repository metadata filtering', () => {
    const parent = 'D:/py-code';
    const child = 'D:/py-code/jj-view';

    it('flags .jj and .git paths of a nested repository', () => {
        expect(isNestedRepositoryMetadataPath(`${child}/.jj/repo/op_heads/heads`, [child])).toBe(true);
        expect(isNestedRepositoryMetadataPath(`${child}/.git/index`, [child])).toBe(true);
        expect(isNestedRepositoryMetadataPath(`${child}/.jj`, [child])).toBe(true);
    });

    it('keeps regular files of the nested repository', () => {
        expect(isNestedRepositoryMetadataPath(`${child}/src/main.ts`, [child])).toBe(false);
        expect(isNestedRepositoryMetadataPath(`${child}/package.json`, [child])).toBe(false);
    });

    it('does not flag the parent repository metadata', () => {
        expect(isNestedRepositoryMetadataPath(`${parent}/.jj/repo/op_heads/heads`, [child])).toBe(false);
        expect(isNestedRepositoryMetadataPath(`${parent}/src/main.ts`, [child])).toBe(false);
    });

    it('matches paths case-insensitively', () => {
        expect(isNestedRepositoryMetadataPath('d:/py-code/JJ-VIEW/.jj/repo/op_heads/heads', [child])).toBe(true);
    });

    it('builds ignore globs relative to the parent root', () => {
        expect(getNestedRepositoryIgnoreGlobs(parent, [child])).toEqual([
            'jj-view/.jj',
            'jj-view/.jj/**',
            'jj-view/.git',
            'jj-view/.git/**',
        ]);
    });

    it('skips roots that are not nested inside the parent', () => {
        expect(getNestedRepositoryIgnoreGlobs(parent, [parent, 'D:/other/repo'])).toEqual([]);
        expect(getNestedRepositoryIgnoreGlobs(parent, [])).toEqual([]);
    });
});
