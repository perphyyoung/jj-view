/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import type { ProcessExecOptions, ProcessResult } from '../core/host/host-system';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { FakeHostEnvironment } from './fake-host-environment';

type ExecFileFn = (file: string, args: readonly string[], options?: ProcessExecOptions) => Promise<ProcessResult>;

/**
 * jj derives the author / committer of a commit from `user.name` / `user.email`
 * in its config. The extension must not block or override that lookup: setting
 * `JJ_CONFIG=''` (or `JJ_USER` / `JJ_EMAIL`) produces commits with
 * "(no name set) <(no email set)>" identities, which `jj git push` refuses.
 */
describe('JjService commit identity environment', () => {
    const workspaceRoot = '/mock/root';
    let execFileSpy: Mock<ExecFileFn>;
    let jjService: JjService;

    const capturedOptions = (): { args: readonly string[]; options: ProcessExecOptions } => {
        expect(execFileSpy).toHaveBeenCalledTimes(1);
        const [, args, options] = execFileSpy.mock.calls[0];
        return { args, options: options ?? {} };
    };

    beforeEach(() => {
        const host = new FakeHostEnvironment();
        execFileSpy = vi.fn<ExecFileFn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
        vi.spyOn(host.system.process, 'execFile').mockImplementation(execFileSpy);
        jjService = new JjService(workspaceRoot, NO_OP_LOGGER, { system: host.system });
    });

    test('commit does not pass any env var that blocks jj identity lookup', async () => {
        await jjService.commit('test commit');

        const { options } = capturedOptions();
        const env = options.env ?? {};

        // Whitelist: any new env var must be reviewed, because NodeHostProcess
        // spreads these over process.env and can silently break jj config.
        expect(Object.keys(env).sort()).toEqual(['EDITOR', 'JJ_EDITOR', 'JJ_VIEW_EXTENSION']);
    });

    test('commit does not override user.name / user.email via --config', async () => {
        await jjService.commit('test commit');

        const { args } = capturedOptions();
        const identityOverrides = args.filter((arg) => /^user\.(name|email)=/.test(arg));
        expect(identityOverrides).toEqual([]);
    });

    test('commit keeps the required env values and ui config flags', async () => {
        await jjService.commit('test commit');

        const { args, options } = capturedOptions();
        const env = options.env ?? {};

        // jj must not open an editor during a non-interactive commit.
        expect(env.JJ_EDITOR).toBeTruthy();
        expect(env.EDITOR).toBeTruthy();
        expect(env.JJ_VIEW_EXTENSION).toBe('1');
        expect(options.cwd).toBe(workspaceRoot);

        // Output parsing depends on these global --config flags.
        expect(args).toEqual(
            expect.arrayContaining([
                'ui.log-word-wrap=false',
                'ui.color="never"',
                'ui.paginate="never"',
                'ui.diff-instructions=false',
            ]),
        );
        expect(args).toContain('commit');
        expect(args).toEqual(expect.arrayContaining(['-m', 'test commit']));
    });
});
