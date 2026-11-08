/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { JjLogEntrySchema } from '../core/jj-schemas';
import type { JjLogEntry } from '../core/jj-types';

/**
 * These cases validate the zod schema and field semantics for log entries.
 * The old repo-tier version created a real jj repository and ran `jj log` for every
 * case just to obtain an object with these fields.
 */
function entry(overrides: Partial<JjLogEntry> = {}): JjLogEntry {
    const identity = { name: 'Test User', email: 'test@example.com', timestamp: '2026-11-08T00:00:00+08:00' };
    return {
        commit_id: 'commit-a',
        change_id: 'change-a',
        description: 'test fields',
        author: identity,
        committer: identity,
        parents: [{ commit_id: 'commit-root', change_id: 'root', is_immutable: true }],
        bookmarks: [],
        is_immutable: false,
        is_current_working_copy: true,
        ...overrides,
    } as JjLogEntry;
}

describe('JjLogEntry field parsing (fixtures)', () => {
    it('parses extended fields', () => {
        const log = entry({ change_id_shortest: 'change', is_immutable: false, is_empty: true });

        expect(log.change_id_shortest).toBeDefined();
        expect(log.is_immutable).toBeDefined();
        expect(log.is_empty).toBeDefined();

        expect(log.is_immutable).toBe(false);
        expect(log.is_empty).toBe(true);

        expect(log.change_id.startsWith(log.change_id_shortest ?? '')).toBe(true);
        expect(log.change_id_shortest?.length).toBeGreaterThan(0);
        expect(log.change_id_shortest?.length).toBeLessThan(log.change_id.length);
    });

    it('detects empty status correctly', () => {
        const notEmpty = entry({ is_empty: false });
        const emptyLog = entry({ is_empty: true });

        expect(notEmpty.is_empty).toBe(false);
        expect(emptyLog.is_empty).toBe(true);
    });

    it('parses parents_immutable correctly', () => {
        const childOfRoot = entry({
            parents: [{ commit_id: 'commit-root', change_id: 'root', is_immutable: true }],
        });
        expect(childOfRoot.parents).toBeDefined();
        expect(childOfRoot.parents.length).toBeGreaterThan(0);
        expect(childOfRoot.parents[0].is_immutable).toBe(true);

        const grandchild = entry({
            parents: [{ commit_id: 'commit-parent', change_id: 'parent', is_immutable: false }],
        });
        expect(grandchild.parents[0].is_immutable).toBe(false);
    });

    it('parses tags correctly', () => {
        const log = entry({ tags: ['test-tag-1', 'test-tag-2'] });

        expect(log.tags).toBeDefined();
        expect(Array.isArray(log.tags)).toBe(true);
        expect(log.tags).toContain('test-tag-1');
        expect(log.tags).toContain('test-tag-2');
        expect(log.tags?.length).toBe(2);
    });

    it('parses author and committer with full details', () => {
        const log = entry();

        expect(typeof log.author).toBe('object');
        expect(typeof log.author.name).toBe('string');
        expect(log.author.name.length).toBeGreaterThan(0);
        expect(log.author.email).toContain('@');

        expect(log.committer?.name).toBe('Test User');
        expect(log.committer?.email).toBe('test@example.com');

        const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
        expect(log.author.timestamp).toMatch(isoPattern);
        expect(log.committer.timestamp).toMatch(isoPattern);

        const authorDate = new Date(log.author.timestamp);
        const committerDate = new Date(log.committer.timestamp);
        expect(authorDate.getTime()).not.toBeNaN();
        expect(committerDate.getTime()).not.toBeNaN();
    });

    it('parses parents correctly', () => {
        const logEntry = entry();

        expect(logEntry.parents).toBeDefined();
        expect(Array.isArray(logEntry.parents)).toBe(true);
        expect(logEntry.parents.length).toBeGreaterThan(0);

        const parent = logEntry.parents[0];
        expect(typeof parent).toBe('object');
        expect(parent).toHaveProperty('commit_id');
        expect(parent).toHaveProperty('change_id');
        expect(parent).toHaveProperty('is_immutable');
    });

    it('validates a fully populated entry against the zod schema', () => {
        const raw = {
            commit_id: 'a'.repeat(32),
            change_id: 'b'.repeat(32),
            change_id_shortest: 'bbbb',
            description: 'multiline\ndescription\ntest',
            author: { name: 'Alice', email: 'alice@example.com', timestamp: '2026-11-08T00:00:00+08:00' },
            committer: { name: 'Bob', email: 'bob@example.com', timestamp: '2026-11-08T00:00:00+08:00' },
            parents: [{ commit_id: 'c'.repeat(32), change_id: 'd'.repeat(32), is_immutable: false }],
            nearest_visible_ancestors: ['e'.repeat(32)],
            bookmarks: [{ name: 'main', remote: null }],
            tags: ['v1.0'],
            is_immutable: false,
            is_current_working_copy: true,
            working_copies: ['default'],
            is_divergent: true,
            change_id_offset: 1,
            changes: [{ path: 'file.txt', status: 'modified', conflicted: false, additions: 1, deletions: 0 }],
            is_empty: false,
        };
        const result = JjLogEntrySchema.safeParse(raw);
        expect(result.success).toBe(true);
    });
});
