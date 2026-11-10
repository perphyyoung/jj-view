/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { untrackCommand } from '../../core/commands/untrack';
import type { JjRepository } from '../../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { Uri } from '../../core/uri-utils';
import { FakeCommandContext } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMock } from '../test-utils';

describe('untrackCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        const mockJjRepo = createMock<JjRepository>({
            jj,
            rootUri: Uri.file(repo.path),
            refresh: vi.fn().mockResolvedValue(undefined),
        });
        ctx = new FakeCommandContext(mockJjRepo);
    });

    const changedPaths = async (): Promise<string[]> => {
        const [entry] = await jj.getLog({ revision: '@', limit: 1 });
        return (entry?.changes ?? []).map((change) => change.path);
    };

    test('ignores and untracks a file, keeping it on disk', async () => {
        repo.writeFile('tracked.txt', 'data');
        expect(await changedPaths()).toContain('tracked.txt');

        await untrackCommand(ctx, { paths: ['tracked.txt'] });

        expect(await changedPaths()).not.toContain('tracked.txt');
        expect(fs.existsSync(path.join(repo.path, 'tracked.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(repo.path, '.gitignore'), 'utf8')).toContain('/tracked.txt');
    });

    test('untracks a folder subtree and ignores the folder for future files', async () => {
        repo.writeFile('src/a.ts', 'a');
        repo.writeFile('src/nested/b.ts', 'b');
        expect(await changedPaths()).toEqual(expect.arrayContaining(['src/a.ts', 'src/nested/b.ts']));

        await untrackCommand(ctx, {
            paths: ['src/a.ts', 'src/nested/b.ts'],
            folder: 'src',
        });

        const paths = await changedPaths();
        expect(paths).not.toContain('src/a.ts');
        expect(paths).not.toContain('src/nested/b.ts');

        const ignore = fs.readFileSync(path.join(repo.path, '.gitignore'), 'utf8');
        expect(ignore).toContain('/src/a.ts');
        expect(ignore).toContain('/src/nested/b.ts');
        expect(ignore).toContain('/src/');
    });
});
