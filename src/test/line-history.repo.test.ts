/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lineHistoryCommand } from '../core/commands/line-history';
import type { JjRepository } from '../core/jj-repository';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { Uri } from '../core/uri-utils';
import { FakeCommandContext, FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMock } from './test-utils';

describe('lineHistoryCommand', () => {
    let repo: TestRepo;
    let jj: JjService;
    let mockRepo: JjRepository;
    let ctx: FakeCommandContext;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        // 5 commits is enough to verify line-history ordering and endpoints.
        for (let i = 1; i <= 5; i++) {
            repo.writeFile('line.txt', `value ${i}\n`);
            repo.describe(`change ${i}`);
            repo.new();
        }
        jj = new JjService(repo.path, NO_OP_LOGGER);
        mockRepo = createMock<JjRepository>({
            rootUri: Uri.file(repo.path),
            jj,
            refresh: async () => {},
        });
        ctx = new FakeCommandContext(mockRepo, new FakeHostEnvironment());
    });

    afterEach(async () => {
        await repo.dispose();
    });

    it('opens the Line History panel with every commit and its line text', async () => {
        await lineHistoryCommand(ctx, { root: repo.path, path: 'line.txt', line: 1 });

        expect(ctx.host.nav.lineHistoryOpened).toHaveLength(1);
        const payload = ctx.host.nav.lineHistoryOpened[0];
        expect(payload.path).toBe('line.txt');
        expect(payload.line).toBe(1);
        expect(payload.entries).toHaveLength(5);
        expect(payload.entries[0].text).toBe('value 5');
        expect(payload.entries[1].text).toBe('value 4');
        expect(payload.entries.at(-1)?.text).toBe('value 1');
    });

    it('starts from the last committed state', async () => {
        await lineHistoryCommand(ctx, { root: repo.path, path: 'line.txt', line: 1 });

        const payload = ctx.host.nav.lineHistoryOpened[0];
        expect(payload.entries[0].sha).toBe(repo.getCommitId('@-'));
    });

    it('does not open the panel when the line has no committed history', async () => {
        const empty = new TestRepo();
        empty.init();
        try {
            const emptyJj = new JjService(empty.path, NO_OP_LOGGER);
            const emptyRepo = createMock<JjRepository>({
                rootUri: Uri.file(empty.path),
                jj: emptyJj,
                refresh: async () => {},
            });
            const emptyCtx = new FakeCommandContext(emptyRepo, new FakeHostEnvironment());

            await lineHistoryCommand(emptyCtx, { root: empty.path, path: 'missing.txt', line: 1 });

            expect(emptyCtx.host.nav.lineHistoryOpened).toHaveLength(0);
            expect(emptyCtx.host.ui.infoMessages.length + emptyCtx.host.ui.errorMessages.length).toBeGreaterThan(0);
        } finally {
            await empty.dispose();
        }
    });
});
