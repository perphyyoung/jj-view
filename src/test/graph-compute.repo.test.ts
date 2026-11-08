/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import type { JjLogEntry } from '../core/jj-types';
import { computeGraphLayout } from '../core/webview/log/graph-compute';
import { type GraphLayout, type GraphNode, isElisionRow } from '../core/webview/log/graph-model';
import { buildGraph, TestRepo } from './test-repo';

// Helper: ASCII renderer to verify layout against jj log output
function renderToAscii(layout: GraphLayout, headId: string): string {
    const rows: string[] = [];
    const nodesById = new Map<string, GraphNode>(layout.nodes.map((n: GraphNode) => [n.changeId, n]));

    const width = layout.width;

    const childDegree = new Map<string, number>();
    const parentDegree = new Map<string, number>();

    layout.rows.forEach((row) => {
        if (!isElisionRow(row)) {
            const parents = row.nearest_visible_ancestors || row.parents.map((p) => p.change_id);
            if (parents.length > 1) {
                childDegree.set(row.change_id, parents.length);
            }
            parents.forEach((p) => {
                parentDegree.set(p, (parentDegree.get(p) || 0) + 1);
            });
        }
    });

    const edgeRoutes = layout.edges.map((e) => {
        const p1 = e.points[0];
        const p2 = e.points[e.points.length - 1];
        const x1 = p1.x;
        const x2 = p2.x;

        const parts = e.id.split('->');
        const childId = parts[0];
        const parentId = parts[1];
        const cleanChildId = childId.startsWith('elided-') ? childId.substring(7) : childId;
        const cleanParentId = parentId.startsWith('elided-') ? parentId.substring(7) : parentId;

        const childNode = nodesById.get(cleanChildId);
        const parentNode = nodesById.get(cleanParentId);

        const y1 = childNode ? childNode.y : Math.floor(p1.y);
        const y2 = parentNode ? parentNode.y : Math.floor(p2.y);

        let yBend = y1;
        for (let j = 1; j < e.points.length; j++) {
            if (e.points[j].x !== x1) {
                yBend = e.points[j].y;
                break;
            }
        }

        return { ...e, x1, y1, x2, y2, yBend };
    });

    for (let i = 0; i < layout.rows.length; i++) {
        const row = layout.rows[i];

        if ('type' in row && row.type === 'elision') {
            // 0. Elision Row (~)
            let lineStr = '';
            for (let x = 0; x < width; x++) {
                let symbol = ' ';
                const hasEdge = edgeRoutes.some((e) => {
                    const isOurElision = e.isElided && e.y1 === i - 1 && (e.x1 === x || e.x2 === x);
                    if (isOurElision) {
                        symbol = '~';
                        return true;
                    }
                    if (e.x1 === e.x2) {
                        return e.x1 === x && e.y1 < i && e.y2 > i;
                    } else {
                        if (x === e.x1 && i < e.yBend && i > e.y1) {
                            return true;
                        }
                        if (x === e.x2 && i > e.yBend && i < e.y2 && !e.isJoining) {
                            return true;
                        }
                        return false;
                    }
                });
                if (hasEdge && symbol === ' ') {
                    symbol = '│';
                }
                lineStr += symbol;
                if (x < width - 1) {
                    lineStr += ' ';
                }
            }
            rows.push(lineStr.trimEnd());
            continue;
        }

        const log = row as JjLogEntry;
        const node = nodesById.get(log.change_id);
        if (!node) {
            continue;
        }

        // 1. Commit Row
        let lineStr = '';
        for (let x = 0; x < width; x++) {
            let symbol = ' ';
            if (node.x === x) {
                symbol = '○';
                if ((log.nearest_visible_ancestors || log.parents).length === 0) {
                    symbol = '◆';
                }
                if (log.is_current_working_copy || log.change_id === headId) {
                    symbol = '@';
                }
            } else {
                const hasEdge = edgeRoutes.some((e) => {
                    // Skip edges that connect to the final root marker (no visible descendants below it in jj log)
                    if (e.y2 >= layout.rows.length - 1) {
                        return false;
                    }

                    if (e.x1 === e.x2) {
                        return e.x1 === x && Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y;
                    } else {
                        if (x === e.x1 && node.y < e.yBend && node.y > e.y1) {
                            return true;
                        }
                        if (x === e.x2 && node.y > e.yBend && node.y < e.y2 && !e.isJoining) {
                            return true;
                        }
                        return false;
                    }
                });
                if (hasEdge) {
                    symbol = '│';
                }
            }
            lineStr += symbol;
            if (x < width - 1) {
                lineStr += ' ';
            }
        }
        // Find furthest active lane for this row to determine padding width
        let maxActiveLane = node.x;
        edgeRoutes.forEach((e) => {
            if (e.y2 >= layout.rows.length - 1) {
                return; // Skip edges to root marker
            }
            if (e.y1 === node.y) {
                // If an edge originates from this node (a fork), the target lane is active
                maxActiveLane = Math.max(maxActiveLane, e.x2);
            }
            if (e.x1 === e.x2) {
                if (Math.min(e.y1, e.y2) < node.y && Math.max(e.y1, e.y2) > node.y) {
                    maxActiveLane = Math.max(maxActiveLane, e.x1);
                }
            } else {
                if (node.y < e.yBend && node.y > e.y1) {
                    maxActiveLane = Math.max(maxActiveLane, e.x1);
                }
                if (node.y > e.yBend && node.y < e.y2) {
                    maxActiveLane = Math.max(maxActiveLane, e.x2);
                }
            }
        });

        const paddedStr = lineStr.trimEnd();
        const requiredLength = maxActiveLane * 2 + 1;
        const finalStr = paddedStr.padEnd(requiredLength, ' ');

        rows.push(`${finalStr}  ${log.change_id.substring(0, 8)} ${log.description.split('\n')[0]}`.trimEnd());

        if ((log.nearest_visible_ancestors || log.parents).length === 0) {
            continue; // No spacer rows needed after a root commit.
        }

        // 2. Spacer Rows (2 lines)
        if (i < layout.rows.length - 1) {
            const nextRow = layout.rows[i + 1];
            if ('type' in nextRow && nextRow.type === 'elision') {
                continue; // Skip spacers if an elision row follows
            }

            const nextLog = nextRow as JjLogEntry;

            // In jj log, if an empty child is connecting to the root commit, it skips the second spacer row
            // to save vertical space.
            const isStraightToRoot =
                (nextLog.nearest_visible_ancestors || nextLog.parents).length === 0 && log.description === '';
            const spacerCount = isStraightToRoot ? 1 : 2;

            for (let s = 0; s < spacerCount; s++) {
                let spacerStr = '';
                // Both spacer rows query at the link-row y-coordinate (node.y + 0.5).
                // Edge points use this exact coordinate for horizontal transitions.
                const yQ = node.y + 0.5;

                for (let x = 0; x < width; x++) {
                    // For the second spacer row (s=1), only show vertical pass-throughs.
                    if (s === 1) {
                        let hasDown = false;
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            for (let j = 0; j < e.points.length - 1; j++) {
                                const pA = e.points[j];
                                const pB = e.points[j + 1];
                                if (pA.x === x && pB.x === x) {
                                    if (Math.min(pA.y, pB.y) <= yQ && Math.max(pA.y, pB.y) > yQ) {
                                        hasDown = true;
                                    }
                                }
                            }
                        });
                        spacerStr += hasDown ? '│' : ' ';
                        if (x < width - 1) {
                            spacerStr += ' ';
                        }
                        continue;
                    }

                    // First spacer row (s=0): detect up/down/left/right at each cell.
                    let up = false;
                    let down = false;
                    let left = false;
                    let right = false;

                    edgeRoutes.forEach((e) => {
                        if (e.y1 > yQ || e.y2 < yQ) {
                            return;
                        }

                        for (let j = 0; j < e.points.length - 1; j++) {
                            const pA = e.points[j];
                            const pB = e.points[j + 1];

                            // Vertical segments at this column
                            if (pA.x === x && pB.x === x) {
                                if (Math.min(pA.y, pB.y) < yQ && Math.max(pA.y, pB.y) >= yQ) {
                                    up = true;
                                }
                                if (Math.min(pA.y, pB.y) <= yQ && Math.max(pA.y, pB.y) > yQ) {
                                    down = true;
                                }
                            }

                            // Horizontal segments at yQ
                            if (pA.y === yQ && pB.y === yQ) {
                                const minX = Math.min(pA.x, pB.x);
                                const maxX = Math.max(pA.x, pB.x);
                                if (minX < x && maxX >= x) {
                                    left = true;
                                }
                                if (minX <= x && maxX > x) {
                                    right = true;
                                }
                            }
                        }
                    });

                    // Calculate independent vertical based on symmetric geometric rules:
                    // A curved symbol (╭ or ╮) is used instead of a T-junction (├ or ┤)
                    // ONLY when it's the target of a curve whose source lane continues.
                    let hasIndependentVertical = true;

                    if (right && !left) {
                        // Left Endpoint: check if it's the target of a leftward curve whose source continues.
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            const childX = e.points[0].x;
                            if (childX > x) {
                                // Must actually have a horizontal segment at yQ touching x
                                const hasHorizAtX = e.points.some((p) => p.y === yQ && p.x === x);
                                if (!hasHorizAtX) {
                                    return;
                                }

                                // Found a leftward curve from childX to x.
                                // Now check if the lane at childX continues below yQ.
                                const sourceContinues = edgeRoutes.some((e_other) => {
                                    if (e_other.y1 > yQ || e_other.y2 < yQ) {
                                        return false;
                                    }
                                    if (e_other === e) {
                                        return false;
                                    }
                                    for (let j = 0; j < e_other.points.length - 1; j++) {
                                        const pA = e_other.points[j];
                                        const pB = e_other.points[j + 1];
                                        if (
                                            pA.x === childX &&
                                            pB.x === childX &&
                                            Math.min(pA.y, pB.y) <= yQ &&
                                            Math.max(pA.y, pB.y) > yQ
                                        ) {
                                            return true;
                                        }
                                    }
                                    return false;
                                });
                                if (sourceContinues) {
                                    hasIndependentVertical = false;
                                }
                            }
                        });
                    } else if (left && !right) {
                        // Right Endpoint: check if it's the target of a rightward curve whose source continues.
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            const childX = e.points[0].x;
                            if (childX < x) {
                                // Must actually have a horizontal segment at yQ touching x
                                const hasHorizAtX = e.points.some((p) => p.y === yQ && p.x === x);
                                if (!hasHorizAtX) {
                                    return;
                                }

                                // Found a rightward curve from childX to x.
                                // Now check if the lane at childX continues below yQ.
                                const sourceContinues = edgeRoutes.some((e_other) => {
                                    if (e_other.y1 > yQ || e_other.y2 < yQ) {
                                        return false;
                                    }
                                    if (e_other === e) {
                                        return false;
                                    }
                                    for (let j = 0; j < e_other.points.length - 1; j++) {
                                        const pA = e_other.points[j];
                                        const pB = e_other.points[j + 1];
                                        if (
                                            pA.x === childX &&
                                            pB.x === childX &&
                                            Math.min(pA.y, pB.y) <= yQ &&
                                            Math.max(pA.y, pB.y) > yQ
                                        ) {
                                            return true;
                                        }
                                    }
                                    return false;
                                });
                                if (sourceContinues) {
                                    hasIndependentVertical = false;
                                }
                            }
                        });
                    }

                    let symbol = ' ';
                    if (up && down && !left && !right) {
                        symbol = '│';
                    } else if (left && right) {
                        symbol = '─';
                    } else if (up && down && right && !left) {
                        symbol = hasIndependentVertical ? '├' : '╭';
                    } else if (up && down && left && !right) {
                        symbol = hasIndependentVertical ? '┤' : '╮';
                    } else if (!up && down && !left && right) {
                        symbol = '╭';
                    } else if (!up && down && left && !right) {
                        symbol = '╮';
                    } else if (up && !down && !left && right) {
                        symbol = '╰';
                    } else if (up && !down && left && !right) {
                        symbol = '╯';
                    } else if ((up || down) && !left && !right) {
                        symbol = '│';
                    } else if (!up && !down && (left || right)) {
                        symbol = '─';
                    }

                    spacerStr += symbol;

                    if (x < width - 1) {
                        let spaceHasHoriz = false;
                        edgeRoutes.forEach((e) => {
                            if (e.y1 > yQ || e.y2 < yQ) {
                                return;
                            }
                            for (let j = 0; j < e.points.length - 1; j++) {
                                const pA = e.points[j];
                                const pB = e.points[j + 1];
                                if (
                                    pA.y === yQ &&
                                    pB.y === yQ &&
                                    Math.min(pA.x, pB.x) <= x &&
                                    Math.max(pA.x, pB.x) >= x + 1
                                ) {
                                    spaceHasHoriz = true;
                                    break;
                                }
                            }
                        });
                        spacerStr += spaceHasHoriz ? '─' : ' ';
                    }
                }
                rows.push(spacerStr.trimEnd());
            }
        }
    }
    return rows.join('\n');
}

describe('Graph Layout Integration Tests (Real jj output)', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    /*
     * Linear History Layout
     *
     * @  C2 (HEAD)
     * ○  C1
     * ○  Root
     */
    test('Multiple Children Curve Routing (Stack Layout Fix)', async () => {
        // Setup:
        // Root -> P
        // P -> A
        // P -> B
        // P -> C
        await buildGraph(repo, [
            { label: 'root', description: 'Root' },
            { label: 'p', description: 'P', parents: ['root'] },
            { label: 'a', description: 'A', parents: ['p'] },
            { label: 'b', description: 'B', parents: ['p'] },
            { label: 'c', description: 'C', parents: ['p'], isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog({ includeNearestVisibleAncestors: true });
        const layout = computeGraphLayout(logs);

        const headLog = logs.find((l) => l.is_current_working_copy);
        const headId = headLog ? headLog.change_id : '';

        const userTemplate = 'change_id.shortest(8) ++ " " ++ description ++ "\\n\\n"';
        const expectedOutput = repo.getLogOutput(userTemplate).trim();
        const generatedOutput = renderToAscii(layout, headId).trim();

        expect(generatedOutput).toBe(expectedOutput);
    });
});
