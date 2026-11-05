/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
    isRepoSortKey,
    REPO_SORT_KEYS,
    REPO_SORT_SHORT_LABELS,
    type RepoSortEntry,
    sortRepos,
} from '../core/repos/sort-repos';

const entry = (name: string, overrides: Partial<RepoSortEntry> = {}): RepoSortEntry => ({
    name,
    changeCount: 0,
    conflictCount: 0,
    ...overrides,
});

const names = (repos: readonly RepoSortEntry[]): string[] => repos.map((repo) => repo.name);

describe('sortRepos', () => {
    const repos = [
        entry('beta', { changeCount: 1, conflictCount: 2, lastCommitAt: '2026-01-02T00:00:00Z', lastUsedAt: 20 }),
        entry('alpha', { changeCount: 3, conflictCount: 0, lastCommitAt: '2026-01-03T00:00:00Z', lastUsedAt: 10 }),
        entry('gamma', { changeCount: 2, conflictCount: 0, lastCommitAt: '2026-01-01T00:00:00Z', lastUsedAt: 30 }),
    ];

    it('keeps the incoming order for the workspace key', () => {
        expect(names(sortRepos(repos, 'workspace'))).toEqual(['beta', 'alpha', 'gamma']);
    });

    it('sorts by name in both directions', () => {
        expect(names(sortRepos(repos, 'name'))).toEqual(['alpha', 'beta', 'gamma']);
        expect(names(sortRepos(repos, 'nameDesc'))).toEqual(['gamma', 'beta', 'alpha']);
    });

    it('sorts by most recent commit', () => {
        expect(names(sortRepos(repos, 'recentCommit'))).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('sorts by most recently used', () => {
        expect(names(sortRepos(repos, 'recentUsed'))).toEqual(['gamma', 'beta', 'alpha']);
    });

    it('sorts by change count and breaks ties by name', () => {
        const withTie = [...repos, entry('delta', { changeCount: 2 })];
        expect(names(sortRepos(withTie, 'changeCount'))).toEqual(['alpha', 'delta', 'gamma', 'beta']);
    });

    it('treats an unknown change count as zero', () => {
        const withUnknown = [entry('unknown'), entry('has', { changeCount: 2 })];
        expect(names(sortRepos(withUnknown, 'changeCount'))).toEqual(['has', 'unknown']);
    });

    it('puts rows with conflicts first', () => {
        expect(names(sortRepos(repos, 'conflicts'))).toEqual(['beta', 'alpha', 'gamma']);
    });

    it('pushes rows without usable timestamps to the end', () => {
        const withMissing = [entry('none'), entry('empty', { lastCommitAt: '' }), repos[1]];
        expect(names(sortRepos(withMissing, 'recentCommit'))).toEqual(['alpha', 'none', 'empty']);
        // alpha carries lastUsedAt; rows never used fall back to the incoming order.
        expect(names(sortRepos(withMissing, 'recentUsed'))).toEqual(['alpha', 'none', 'empty']);
    });

    it('does not mutate the input array', () => {
        const original = [...repos];
        sortRepos(repos, 'name');
        expect(repos).toEqual(original);
    });

    it('validates sort keys', () => {
        expect(isRepoSortKey('conflicts')).toBe(true);
        expect(isRepoSortKey('nope')).toBe(false);
        expect(REPO_SORT_KEYS).toContain('recentCommit');
    });

    it('provides a compact title-bar label for every sort key', () => {
        for (const key of REPO_SORT_KEYS) {
            expect(REPO_SORT_SHORT_LABELS[key]?.length ?? 0).toBeGreaterThan(0);
            expect(REPO_SORT_SHORT_LABELS[key].length).toBeLessThanOrEqual(14);
        }
    });
});
