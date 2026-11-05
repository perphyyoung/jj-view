/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** How the Repositories view orders its rows. */
export type RepoSortKey =
    | 'workspace'
    | 'name'
    | 'nameDesc'
    | 'recentCommit'
    | 'recentUsed'
    | 'changeCount'
    | 'conflicts';

/** Sort keys in the order they are offered in the title-bar picker. */
export const REPO_SORT_KEYS: readonly RepoSortKey[] = [
    'workspace',
    'name',
    'nameDesc',
    'recentCommit',
    'recentUsed',
    'changeCount',
    'conflicts',
];

/** Human-readable label per sort key (used by the title-bar picker). */
export const REPO_SORT_LABELS: Record<RepoSortKey, string> = {
    workspace: 'Workspace Order',
    name: 'Name (A to Z)',
    nameDesc: 'Name (Z to A)',
    recentCommit: 'Recent Commit',
    recentUsed: 'Recently Used',
    changeCount: 'Change Count',
    conflicts: 'Conflicts First',
};

export const DEFAULT_REPO_SORT: RepoSortKey = 'workspace';

export function isRepoSortKey(value: unknown): value is RepoSortKey {
    return typeof value === 'string' && (REPO_SORT_KEYS as readonly string[]).includes(value);
}

/** The fields the sort needs; callers pass their own richer rows. */
export interface RepoSortEntry {
    name: string;
    changeCount: number;
    conflictCount: number;
    /** Committer timestamp of `@`, ISO string. Missing until the repo was refreshed. */
    lastCommitAt?: string;
    /** Epoch milliseconds of the last time the repo was focused in this window. */
    lastUsedAt?: number;
}

const timestamp = (value: string | undefined): number => {
    if (!value) {
        return Number.NEGATIVE_INFINITY;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const nameOf = (entry: RepoSortEntry): string => entry.name.toLowerCase();

/**
 * Orders repository rows. Every key falls back to the incoming order, so equal entries
 * never swap between renders.
 */
export function sortRepos<T extends RepoSortEntry>(repos: readonly T[], key: RepoSortKey): T[] {
    const indexed = repos.map((repo, index) => ({ repo, index }));
    const byOrder = (a: { index: number }, b: { index: number }): number => a.index - b.index;

    indexed.sort((a, b) => {
        const left = a.repo;
        const right = b.repo;
        switch (key) {
            case 'name':
                return nameOf(left).localeCompare(nameOf(right)) || byOrder(a, b);
            case 'nameDesc':
                return nameOf(right).localeCompare(nameOf(left)) || byOrder(a, b);
            case 'recentCommit':
                return timestamp(right.lastCommitAt) - timestamp(left.lastCommitAt) || byOrder(a, b);
            case 'recentUsed':
                return (
                    (right.lastUsedAt ?? Number.NEGATIVE_INFINITY) - (left.lastUsedAt ?? Number.NEGATIVE_INFINITY) ||
                    byOrder(a, b)
                );
            case 'changeCount':
                return (
                    right.changeCount - left.changeCount || nameOf(left).localeCompare(nameOf(right)) || byOrder(a, b)
                );
            case 'conflicts': {
                const leftHas = left.conflictCount > 0 ? 1 : 0;
                const rightHas = right.conflictCount > 0 ? 1 : 0;
                return rightHas - leftHas || byOrder(a, b);
            }
            default:
                return byOrder(a, b);
        }
    });

    return indexed.map((entry) => entry.repo);
}
