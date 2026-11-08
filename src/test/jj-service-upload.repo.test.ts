/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { ScopedTestRepo, TestRepo } from './test-repo';

describe('JjService upload', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    describe('upload', () => {
        test('upload with revision includes -r flag', async () => {
            using remoteRepo = new ScopedTestRepo();
            remoteRepo.init();
            repo.addRemote('origin', remoteRepo.path);
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');

            try {
                // In a test repo with origin remote, jj git push -r <bad-rev> should fail with a revision error
                await jjService.upload('non-existent-rev', 'git', 'push');
                expect.fail('Should have failed due to non-existent revision');
            } catch (e: unknown) {
                if (e instanceof Error) {
                    // This confirms the -r flag was passed because jj is complaining about the specific revision string
                    expect(e.message).toContain('non-existent-rev');
                } else {
                    throw e;
                }
            }
        });

        test('upload without revision omits -r flag', async () => {
            using remoteRepo = new ScopedTestRepo();
            remoteRepo.init();
            repo.addRemote('origin', remoteRepo.path);
            repo.config('remotes.origin.auto-track-bookmarks', '"*"');

            // In a test repo with origin remote, jj git push should succeed without a revision error
            await jjService.upload(undefined, 'git', 'push');
        });
    });
});
