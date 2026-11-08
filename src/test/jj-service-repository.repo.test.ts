/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService repository discovery', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('getWorkingCopyChanges detects added file', async () => {
        repo.writeFile('new-file.txt', 'content');

        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(1);
        expect(changes[0].path).toBe('new-file.txt');
        expect(changes[0].status).toBe('added');
    });

    test('getWorkingCopyChanges detects modified file', async () => {
        await buildGraph(repo, [
            { label: 'initial', description: 'initial', files: { 'file.txt': 'initial' } },
            { parents: ['initial'], files: { 'file.txt': 'modified' }, isCurrentWorkingCopy: true },
        ]);

        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(1);
        expect(changes[0].path).toBe('file.txt');
        expect(changes[0].status).toBe('modified');
    });

    test('getWorkingCopyChanges handles empty working copy', async () => {
        repo.snapshot();
        const changes = await jjService.getWorkingCopyChanges();
        expect(changes.length).toBe(0);
    });

    test('getGitRoot returns valid path for git-backed repo and memoizes result', async () => {
        const gitRoot1 = await jjService.getGitRoot();
        expect(gitRoot1).toBeTruthy();
        expect(gitRoot1).toContain('.git');

        const gitRoot2 = await jjService.getGitRoot();
        expect(gitRoot2).toBe(gitRoot1);
    });

    test('getRepoStorePath returns directory for main repo', async () => {
        const storePath = await jjService.getRepoStorePath();
        expect(fs.realpathSync.native(storePath)).toBe(fs.realpathSync.native(path.join(repo.path, '.jj', 'repo')));
        const stats = await fs.promises.lstat(storePath);
        expect(stats.isDirectory()).toBe(true);
    });

    test('getMainWorkspaceRoot returns same path for main repo', async () => {
        const mainRoot = await jjService.getMainWorkspaceRoot();
        expect(fs.realpathSync.native(mainRoot)).toBe(fs.realpathSync.native(repo.path));
    });

    test('repository discovery in secondary workspace', async () => {
        const secondRepo = repo.workspaceAdd('second_ws');
        const secondJj = new JjService(secondRepo.path, {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        });

        const storePath = await secondJj.getRepoStorePath();
        const mainRoot = await secondJj.getMainWorkspaceRoot();

        // Should point back to the original repo
        expect(fs.realpathSync.native(storePath)).toBe(fs.realpathSync.native(path.join(repo.path, '.jj', 'repo')));
        expect(fs.realpathSync.native(mainRoot)).toBe(fs.realpathSync.native(repo.path));
    });

    test('supplies JJ_VIEW_EXTENSION environment variable', async () => {
        // Write a conditional config that changes the default log revset
        // only when JJ_VIEW_EXTENSION=1 is present in the environment.
        // Modern jj stores repo configs outside the repo for security,
        // so we must query the path dynamically.
        const configPath = cp
            .execFileSync('jj', ['config', 'path', '--repo'], { cwd: repo.path, encoding: 'utf-8' })
            .trim();
        const configContent = `
[[--scope]]
--when.environments = ["JJ_VIEW_EXTENSION=1"]
[--scope.revsets]
log = "none()"
`;
        // Append to existing config
        fs.appendFileSync(configPath, configContent, 'utf-8');

        // Verify that JjService picks up the environment variable by
        // checking the output of getLog without a revision (which uses revsets.log)
        repo.new(['@'], 'child');

        // JjService execution should use JJ_VIEW_EXTENSION=1, making revsets.log = "none()"
        const logs = await jjService.getLog();
        expect(logs.length).toBe(0);

        // TestRepo execution should NOT use JJ_VIEW_EXTENSION=1, making revsets.log = "@"
        const repoLogDesc = repo.getDescription('@');
        expect(repoLogDesc).toContain('child');
    });
});
