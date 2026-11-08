/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JjLogEntry } from '../core/jj-types';
import { computeGraphLayout } from '../core/webview/log/graph-compute';

/**
 * Layout is a pure projection of log entries. These cases used to build a real jj graph
 * (3-5 `jj new` calls each) just to obtain the entries; fixtures remove all of that.
 */
function entry(
    changeId: string,
    description: string,
    parents: JjLogEntry[],
    overrides: Partial<JjLogEntry> = {},
): JjLogEntry {
    const identity = { name: 'Test User', email: 'test@example.com', timestamp: '2026-11-08T00:00:00+00:00' };
    return {
        commit_id: `commit-${changeId}`,
        change_id: changeId,
        description,
        author: identity,
        committer: identity,
        parents: parents.map((p) => ({
            commit_id: p.commit_id,
            change_id: p.change_id,
            is_immutable: false,
        })),
        bookmarks: [],
        is_immutable: false,
        is_current_working_copy: false,
        ...overrides,
    } as JjLogEntry;
}

/** jj log order: newest first. */
function logOrder(...entries: JjLogEntry[]): JjLogEntry[] {
    return entries;
}

describe('computeGraphLayout (fixtures)', () => {
    it('places a linear history in a single lane with ordered rows', () => {
        const root = entry('root', 'Root', []);
        const c1 = entry('c1', 'C1', [root]);
        const c2 = entry('c2', 'C2', [c1], { is_current_working_copy: true });

        const layout = computeGraphLayout(logOrder(c2, c1, root));
        const nodes = layout.nodes;

        const forRoot = nodes.find((n) => n.changeId === 'root');
        const forC1 = nodes.find((n) => n.changeId === 'c1');
        const forC2 = nodes.find((n) => n.changeId === 'c2');

        expect(forRoot).toBeDefined();
        expect(forC1).toBeDefined();
        expect(forC2).toBeDefined();
        expect([forRoot?.x, forC1?.x, forC2?.x]).toEqual([0, 0, 0]);
        expect(forC2?.y).toBeLessThan(forC1?.y as number);
        expect(forC1?.y).toBeLessThan(forRoot?.y as number);

        const edge = layout.edges.find(
            (e) => Math.floor(e.points[0].y) === forC2?.y && Math.floor(e.points[e.points.length - 1].y) === forC1?.y,
        );
        expect(edge).toBeDefined();
    });

    it('assigns different lanes to siblings of a fork', () => {
        const root = entry('root', 'Root', []);
        const parent = entry('parent', 'Parent', [root]);
        const child1 = entry('child1', 'Child1', [parent]);
        const child2 = entry('child2', 'Child2', [parent], { is_current_working_copy: true });

        const layout = computeGraphLayout(logOrder(child2, child1, parent, root));
        const nodes = layout.nodes;
        const forParent = nodes.find((n) => n.changeId === 'parent');
        const forChild1 = nodes.find((n) => n.changeId === 'child1');
        const forChild2 = nodes.find((n) => n.changeId === 'child2');

        expect(forChild1?.y).toBeLessThan(forParent?.y as number);
        expect(forChild2?.y).toBeLessThan(forParent?.y as number);
        expect(forChild1?.x).not.toBe(forChild2?.x);

        const edge1 = layout.edges.some(
            (e) =>
                (Math.floor(e.points[0].y) === forChild1?.y &&
                    Math.floor(e.points[e.points.length - 1].y) === forParent?.y) ||
                (Math.floor(e.points[e.points.length - 1].y) === forChild1?.y &&
                    Math.floor(e.points[0].y) === forParent?.y),
        );
        const edge2 = layout.edges.some(
            (e) =>
                (Math.floor(e.points[0].y) === forChild2?.y &&
                    Math.floor(e.points[e.points.length - 1].y) === forParent?.y) ||
                (Math.floor(e.points[e.points.length - 1].y) === forChild2?.y &&
                    Math.floor(e.points[0].y) === forParent?.y),
        );
        expect(edge1).toBe(true);
        expect(edge2).toBe(true);
    });

    it('connects a merge commit to both parents', () => {
        const root = entry('root', 'Root', []);
        const p1 = entry('p1', 'P1', [root]);
        const p2 = entry('p2', 'P2', [root]);
        const merge = entry('merge', 'MergeChild', [p1, p2], { is_current_working_copy: true });

        const layout = computeGraphLayout(logOrder(merge, p2, p1, root));
        const nodes = layout.nodes;
        const forMerge = nodes.find((n) => n.changeId === 'merge');
        const forP1 = nodes.find((n) => n.changeId === 'p1');
        const forP2 = nodes.find((n) => n.changeId === 'p2');

        const e1 = layout.edges.find(
            (e) =>
                Math.floor(e.points[0].y) === forMerge?.y && Math.floor(e.points[e.points.length - 1].y) === forP1?.y,
        );
        const e2 = layout.edges.find(
            (e) =>
                Math.floor(e.points[0].y) === forMerge?.y && Math.floor(e.points[e.points.length - 1].y) === forP2?.y,
        );
        expect(e1).toBeDefined();
        expect(e2).toBeDefined();

        if (forP1?.y === forP2?.y) {
            expect(forP1?.x).not.toBe(forP2?.x);
        }
    });

    it('marks an edge as elided when the middle commit is hidden', () => {
        const a = entry('a', 'A', []);
        const b = entry('b', 'B', [a]);
        const c = entry('c', 'C', [b], { nearest_visible_ancestors: [a.change_id] });

        const layout = computeGraphLayout(logOrder(c, a));
        const cNode = layout.nodes.find((n) => n.changeId === 'c');
        const aNode = layout.nodes.find((n) => n.changeId === 'a');

        expect(cNode).toBeDefined();
        expect(aNode).toBeDefined();

        const edge = layout.edges.find(
            (e) => Math.floor(e.points[0].y) === cNode?.y && Math.floor(e.points[e.points.length - 1].y) === aNode?.y,
        );
        expect(edge).toBeDefined();
        expect(edge?.isElided).toBe(true);
    });

    it.each([
        {
            name: 'complex replay with three forks',
            specs: [
                ['initial', []],
                ['fakeTS', ['initial']],
                ['cc', ['fakeTS']],
                ['cool', ['initial']],
                ['vpm', ['cool']],
                ['orcs', ['cool']],
                ['head', ['vpm'], true],
            ] as const,
        },
        {
            name: 'merge with descendants and side branch',
            specs: [
                ['base', []],
                ['main', ['base']],
                ['side', ['base']],
                ['merge', ['main', 'side']],
                ['chain', ['merge']],
                ['branch', ['main']],
                ['wc', ['main'], true],
            ] as const,
        },
        {
            name: 'deep nesting across multiple lanes',
            specs: [
                ['lvtk', []],
                ['zonk', ['lvtk']],
                ['vqpn', ['lvtk']],
                ['kppt', ['vqpn', 'zonk']],
                ['lrnm', ['kppt']],
                ['rtox', ['kppt']],
                ['posk', ['rtox']],
                ['smyx', ['posk']],
                ['plko', ['lrnm']],
                ['mnry', ['plko']],
                ['txmw', ['plko']],
                ['yukr', ['smyx']],
                ['mpsp', ['vqpn']],
                ['vxmy', ['yukr']],
                ['uoym', ['zonk'], true],
            ] as const,
        },
        {
            name: 'overlapping multi-child layout',
            specs: [
                ['lv', []],
                ['vq', ['lv']],
                ['mp', ['vq']],
                ['xn', ['lv']],
                ['yz', ['lv']],
                ['on', ['lv']],
                ['zo', ['lv']],
                ['kp', ['vq', 'zo']],
                ['lr', ['kp']],
                ['pl', ['lr']],
                ['mn', ['pl']],
                ['tx', ['pl']],
                ['rt', ['kp']],
                ['po', ['rt']],
                ['sm', ['po']],
                ['yu', ['sm']],
                ['vx', ['yu']],
                ['ux', ['vx']],
                ['wr', ['ux'], true],
            ] as const,
        },
    ])('keeps every node and parent edge for $name', ({ specs }) => {
        const built: JjLogEntry[] = [];
        let edgeCount = 0;
        for (const [id, parentIds, isWc] of specs) {
            const parents = parentIds.map((parentId) => {
                const parent = built.find((e) => e.change_id === parentId);
                if (!parent) {
                    throw new Error(`parent ${parentId} not built before ${id}`);
                }
                return parent;
            });
            edgeCount += parents.length;
            built.push(
                entry(id, id, parents, {
                    is_current_working_copy: isWc === true,
                }),
            );
        }

        const logs = built.slice().reverse();
        const layout = computeGraphLayout(logs);

        expect(layout.nodes).toHaveLength(specs.length);
        expect(new Set(layout.nodes.map((n) => n.changeId)).size).toBe(specs.length);
        expect(layout.edges.length).toBeGreaterThanOrEqual(edgeCount);
        expect(layout.width).toBeGreaterThan(0);

        const wc = layout.nodes.find((n) => n.changeId === specs[specs.length - 1][0]);
        expect(wc?.y).toBe(0);
    });
});
