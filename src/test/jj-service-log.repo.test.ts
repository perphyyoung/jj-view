/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { TestRepo } from './test-repo';

describe('JjService log and annotate', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

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
});
