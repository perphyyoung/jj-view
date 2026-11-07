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
        for (let i = 1; i <= 12; i++) {
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

    it('shows the ten most recent commits and a load-more item', async () => {
        await lineHistoryCommand(ctx, { root: repo.path, path: 'line.txt', line: 1 });

        const call = ctx.host.ui.quickPickCalls[0];
        expect(call.items).toHaveLength(11);
        expect(call.items.at(-1)?.label).toContain('Load more');
        expect(call.items.at(-1)?.description).toContain('2 remaining');
        expect(call.items[0].label).toContain('change 12');
        expect(call.options?.placeHolder).toContain('10 of 12 commits');
    });

    it('loads the next page when the load-more item is selected', async () => {
        // The picker reopens inside the same command call, so answer the first prompt with
        // the load-more item (value: null) and let the loop request the next page.
        ctx.host.ui.setNextQuickPickResponse({ label: 'Load more', value: null });

        await lineHistoryCommand(ctx, { root: repo.path, path: 'line.txt', line: 1 });

        expect(ctx.host.ui.quickPickCalls).toHaveLength(2);
        const last = ctx.host.ui.quickPickCalls.at(-1);
        expect(last?.items).toHaveLength(12);
        expect(last?.items.some((item) => item.label.includes('Load more'))).toBe(false);
    });

    it('starts from the last committed state and matches git', async () => {
        await lineHistoryCommand(ctx, { root: repo.path, path: 'line.txt', line: 1 });

        const firstLabel = ctx.host.ui.quickPickCalls[0].items[0].label;
        const headSha = repo.getCommitId('@-');
        expect(firstLabel).toContain(headSha.slice(0, 8));
    });
});
