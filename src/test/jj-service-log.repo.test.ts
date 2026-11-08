/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService log and annotate', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('getLog returns valid log entry', async () => {
        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.change_id).toBeTruthy();
        expect(log.commit_id).toBeTruthy();
    });

    test('annotateFile with a line range returns only those lines', async () => {
        const content = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
        repo.writeFile('range.txt', content);
        const all = await jjService.annotateFile('range.txt');
        expect(all?.length).toBe(20);

        const windowed = await jjService.annotateFile('range.txt', '@', { from: 5, to: 7 });
        expect(windowed?.map((a) => a.line)).toEqual([5, 6, 7]);
    });

    test('annotateFile reports the committer time, like jj log', async () => {
        repo.writeFile('stamp.txt', 'stamp\n');
        repo.describe('first');
        repo.new();
        // Rewriting the commit updates only the committer timestamp.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        repo.describe('rewritten', '@-');

        const annotations = await jjService.annotateFile('stamp.txt');
        const read = (template: string) =>
            Number(
                cp
                    .execFileSync('jj', ['log', '-r', '@-', '--no-graph', '-T', template], {
                        cwd: repo.path,
                        encoding: 'utf8',
                    })
                    .trim(),
            );
        const committer = read('committer.timestamp().format("%s")');
        const author = read('author.timestamp().format("%s")');

        expect(committer).not.toBe(author);
        expect(annotations?.[0].timestamp).toBe(committer * 1000);
    });

    test('whenIdle resolves immediately when no mutation is running', async () => {
        await expect(jjService.whenIdle()).resolves.toBe(true);
    });

    test('whenIdle reports busy while a mutation is in flight', async () => {
        const mutation = jjService.status();
        // runMutation bumps the write counter synchronously, so the repo is busy right here.
        await expect(jjService.whenIdle({ timeoutMs: 0 })).resolves.toBe(false);
        await mutation;
        await expect(jjService.whenIdle()).resolves.toBe(true);
    });

    test('getLog caches entries by immutable commit_id on omitChanges and returns defensively cloned copies', async () => {
        repo.describe('test cache commit', '@');
        const [original] = await jjService.getLog({ revision: '@', omitChanges: true });
        expect(original.description.trim()).toBe('test cache commit');

        // Look up via commit_id (hits memory cache)
        const cachedByCommitId = await jjService.getLogEntry(original.commit_id);
        expect(cachedByCommitId).toBeDefined();
        expect(cachedByCommitId?.change_id).toBe(original.change_id);
        expect(cachedByCommitId?.commit_id).toBe(original.commit_id);

        // Verify defensive cloning: modifying returned entry does not mutate cached value
        if (cachedByCommitId) {
            cachedByCommitId.description = 'corrupted in memory';
        }
        const fresh = await jjService.getLogEntry(original.commit_id);
        expect(fresh?.description.trim()).toBe('test cache commit');
    });

    test('clearCache invalidates log entry cache and allows fresh retrieval', async () => {
        repo.describe('before clear', '@');
        const [initial] = await jjService.getLog({ revision: '@', omitChanges: true });
        expect(initial.description.trim()).toBe('before clear');

        // Looking up by commit_id hits cache
        const cached = await jjService.getLogEntry(initial.commit_id);
        expect(cached?.description.trim()).toBe('before clear');

        // clearCache empties memory cache
        await jjService.clearCache();
        const fresh = await jjService.getLogEntry(initial.commit_id);
        expect(fresh?.description.trim()).toBe('before clear');
    });

    test('runMutation automatically invalidates log entry cache', async () => {
        repo.describe('initial desc', '@');
        const [initial] = await jjService.getLog({ revision: '@', omitChanges: true });
        expect(initial.description.trim()).toBe('initial desc');

        // Describe via jjService (which runs as a mutation)
        await jjService.describe('mutated via jjService', '@');

        const updated = await jjService.getLogEntry(initial.change_id);
        expect(updated?.description.trim()).toBe('mutated via jjService');
    });

    // === Entry fields parity (from jj-service-log-entry-fields) ===

    test('real jj output parses into valid JjLogEntry fields', async () => {
        await repo.initWithGraph('single-commit', [{ label: 'c', description: 'parity test' }]);
        const [log] = await jjService.getLog({ revision: '@' });

        expect(log.commit_id).toBeTruthy();
        expect(log.change_id).toBeTruthy();
        expect(log.description.trim()).toBe('parity test');

        expect(log.change_id_shortest).toBeDefined();
        expect(log.is_immutable).toBeDefined();
        expect(log.is_empty).toBeDefined();
        expect(log.is_immutable).toBe(false);
        expect(log.is_empty).toBe(true);

        expect(typeof log.author.name).toBe('string');
        expect(log.author.email).toContain('@');
        expect(log.committer?.name).toBe('Test User');

        expect(Array.isArray(log.parents)).toBe(true);
        if (log.parents.length > 0) {
            expect(log.parents[0]).toHaveProperty('commit_id');
            expect(log.parents[0]).toHaveProperty('change_id');
            expect(log.parents[0]).toHaveProperty('is_immutable');
        }
    });

    // === Ancestry and workspaces (from jj-service-log-ancestry) ===

    test('detects divergent commits and offsets', async () => {
        repo.describe('version 1');
        const commitIdV1 = repo.getCommitId('@');

        repo.describe('version 2');
        const commitIdV2 = repo.getCommitId('@');

        repo.bookmark('old-version', commitIdV1);

        const logs = await jjService.getLog({ revision: 'all()' });

        const v1Entry = logs.find((l) => l.commit_id === commitIdV1);
        const v2Entry = logs.find((l) => l.commit_id === commitIdV2);

        expect(v1Entry).toBeDefined();
        expect(v2Entry).toBeDefined();

        expect(v1Entry?.is_divergent).toBe(true);
        expect(v2Entry?.is_divergent).toBe(true);

        expect(v1Entry?.change_id).toMatch(/\/\d+$/);
        expect(v2Entry?.change_id).toMatch(/\/\d+$/);

        expect(v1Entry?.change_id_offset).toBe(1);
        expect(v2Entry?.change_id_offset).toBe(0);
        expect(v1Entry?.change_id_offset).not.toBe(v2Entry?.change_id_offset);
    });

    test('includes workspace labels in working_copies field', async () => {
        const workspaceName = 'repo2';

        const otherCommit = await buildGraph(repo, [{ label: 'other', description: 'other' }]);
        const otherCommitId = otherCommit.other.changeId;

        const currentWcId = repo.getChangeId('@');

        repo.workspaceAdd(workspaceName, otherCommitId);

        const logs = await jjService.getLog({ revision: 'all()' });

        const repo2WcEntry = logs.find((l) => l.working_copies?.some((w) => w.startsWith(workspaceName)));

        expect(repo2WcEntry).toBeDefined();
        expect(repo2WcEntry?.is_current_working_copy).toBe(false);

        const currentWcEntry = logs.find((l) => l.is_current_working_copy);
        expect(currentWcEntry).toBeDefined();
        expect(currentWcEntry?.change_id).toBe(currentWcId);
        expect(currentWcEntry?.working_copies).toContain('default');
    });

    test('without revisions returns multiple entries', async () => {
        await repo.initWithGraph('three-linear', [
            { label: 'c1', description: 'c1' },
            { label: 'c2', parents: ['c1'], description: 'c2' },
            { label: 'c3', parents: ['c2'], description: 'c3' },
        ]);

        const logs = await jjService.getLog();
        expect(logs.length).toBeGreaterThanOrEqual(3);
    });

    test('populates nearest_visible_ancestors with gaps', async () => {
        const ids = await buildGraph(repo, [
            { label: 'A', description: 'commit A' },
            { label: 'B', parents: ['A'], description: 'commit B' },
            { label: 'C', parents: ['B'], description: 'commit C' },
            { label: 'D', parents: ['C'], description: 'commit D' },
        ]);

        const idA = ids.A.changeId;
        const idD = ids.D.changeId;

        const logs = await jjService.getLog({
            revision: `(${idA} | ${idD})`,
            includeNearestVisibleAncestors: true,
        });

        const logD = logs.find((l) => l.change_id === idD);
        const logA = logs.find((l) => l.change_id === idA);

        expect(logD).toBeDefined();
        expect(logA).toBeDefined();

        expect(logD?.parents[0].commit_id).toBe(ids.C.commitId);
        expect(logD?.parents[0].change_id).toBe(ids.C.changeId);

        expect(logD?.nearest_visible_ancestors).toContain(idA);
        expect(logD?.nearest_visible_ancestors?.length).toBe(1);
        expect(logA?.nearest_visible_ancestors?.length).toBe(0);
    });

    test('does not populate nearest_visible_ancestors by default', async () => {
        repo.describe('test');
        const [log] = await jjService.getLog({ revision: '@' });
        expect(log.nearest_visible_ancestors).toBeUndefined();
    });

    test('getChildren returns correct children', async () => {
        const ids = await buildGraph(repo, [
            { label: 'parent', description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            { label: 'child2', parents: ['parent'], description: 'child2' },
        ]);
        const parentId = ids.parent.changeId;

        const children = await jjService.getChildren(parentId);
        expect(children.length).toBe(2);
    });

    // === Graph and file changes (from jj-service-log-graph) ===

    test('handles complex graph (forks)', async () => {
        await buildGraph(repo, [
            { label: 'root', description: 'root' },
            { label: 'parent', parents: ['root'], description: 'parent' },
            { label: 'child1', parents: ['parent'], description: 'child1' },
            { label: 'child2', parents: ['parent'], description: 'child2', isCurrentWorkingCopy: true },
        ]);

        const logs = await jjService.getLog();

        expect(logs.length).toBeGreaterThanOrEqual(4);

        const child1Log = logs.find((l) => l.description.trim() === 'child1');
        const child2Log = logs.find((l) => l.description.trim() === 'child2');
        const parentLog = logs.find((l) => l.description.trim() === 'parent');

        expect(child1Log).toBeDefined();
        expect(child2Log).toBeDefined();
        expect(parentLog).toBeDefined();

        expect(child1Log?.parents[0].commit_id).toBe(parentLog?.commit_id);
        expect(child2Log?.parents[0].commit_id).toBe(parentLog?.commit_id);
    }, 30000);

    test('Complex Replay (Reproduce User Scenario) with return IDs', async () => {
        const { Initial, FakeTS, CC, Cool, VPM, Orcs, HEAD } = await buildGraph(repo, [
            { label: 'Initial', description: 'initial commit' },
            { label: 'FakeTS', parents: ['Initial'], description: 'Added a fake ts file' },
            { label: 'CC', parents: ['FakeTS'], description: 'cc file and stuff' },
            { label: 'Cool', parents: ['Initial'], description: "It's pretty cool I guess" },
            { label: 'VPM', parents: ['Cool'], description: 'vpmososp' },
            { label: 'Orcs', parents: ['Cool'], description: 'Orcs are coming' },
            { label: 'HEAD', parents: ['VPM'], description: 'tqlynzyq', isCurrentWorkingCopy: true },
        ]);

        const headId = HEAD.changeId;

        repo.edit(headId);
        const logs = await jjService.getLog();

        const getDesc = (id: string) => logs.find((l) => l.change_id === id)?.description.trim();
        const getParents = (id: string) => {
            const entry = logs.find((l) => l.change_id === id);
            if (!entry) {
                return [];
            }
            return entry.parents
                .map((p) => {
                    const parentLog = logs.find((l) => l.commit_id === p.commit_id);
                    return parentLog ? parentLog.change_id : undefined;
                })
                .filter(Boolean);
        };

        expect(getDesc(Initial.changeId)).toContain('initial commit');
        expect(getDesc(FakeTS.changeId)).toContain('Added a fake ts file');
        expect(getDesc(CC.changeId)).toContain('cc file');
        expect(getDesc(Cool.changeId)).toContain('pretty cool');
        expect(getDesc(VPM.changeId)).toContain('vpmososp');
        expect(getDesc(HEAD.changeId)).toContain('tqlynzyq');
        expect(getDesc(Orcs.changeId)).toContain('Orcs');

        expect(getParents(FakeTS.changeId)).toContain(Initial.changeId);
        expect(getParents(Cool.changeId)).toContain(Initial.changeId);
        expect(getParents(CC.changeId)).toContain(FakeTS.changeId);
        expect(getParents(VPM.changeId)).toContain(Cool.changeId);
        expect(getParents(Orcs.changeId)).toContain(Cool.changeId);
        expect(getParents(HEAD.changeId)).toContain(VPM.changeId);
    }, 30000);

    test('returns file changes with statuses', async () => {
        await buildGraph(repo, [
            {
                label: 'setup',
                description: 'setup',
                files: { 'modified.txt': 'initial', 'deleted.txt': 'to delete' },
            },
            { parents: ['setup'], isCurrentWorkingCopy: true },
        ]);

        repo.writeFile('added.txt', 'new');
        repo.writeFile('modified.txt', 'modified');
        repo.deleteFile('deleted.txt');

        const [log] = await jjService.getLog({ revision: '@' });
        const changes = log.changes;
        if (!changes) {
            throw new Error('changes not found');
        }

        expect(changes.find((c) => c.path === 'added.txt')?.status).toBe('added');
        expect(changes.find((c) => c.path === 'modified.txt')?.status).toBe('modified');
        expect(changes.find((c) => c.path === 'deleted.txt')?.status).toBe('deleted');
    });

    test('includes oldPath for renamed files', async () => {
        const oldFile = 'old-log-rename.txt';
        const newFile = 'new-log-rename.txt';
        repo.writeFile(oldFile, 'log rename content');
        repo.describe('parent');
        await jjService.new();
        repo.moveFile(oldFile, newFile);

        const [logEntry] = await jjService.getLog({ revision: '@' });
        expect(logEntry).toBeDefined();

        const changes = logEntry.changes || [];
        const renameEntry = changes.find((c) => c.path === newFile);
        expect(renameEntry).toBeDefined();
        expect(renameEntry?.status).toBe('renamed');
        expect(renameEntry?.oldPath).toBe(oldFile);
    });

    test('handles atypical workspace names', async () => {
        const alphaRepo = repo.workspaceAdd('alpha:1.0', undefined, path.join(repo.path, 'alpha_1.0'));
        alphaRepo.new();

        const logEntries = await jjService.getLog({ revision: alphaRepo.getWorkingCopyId() });

        expect(logEntries.length).toBeGreaterThan(0);
        const head = logEntries[0];
        expect(head.working_copies).toContain('alpha:1.0');
    });
});
