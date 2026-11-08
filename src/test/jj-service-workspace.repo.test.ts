/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { TestRepo } from './test-repo';

describe('JjService workspace commands', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();

        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('workspaceAdd creates a new workspace', async () => {
        const wsPath = path.join(repo.path, 'new_ws');
        await jjService.workspaceAdd(wsPath, 'new_ws');

        expect(fs.existsSync(wsPath)).toBe(true);
        expect(fs.existsSync(path.join(wsPath, '.jj'))).toBe(true);

        // Verify it shows up in workspace list
        const output = repo.listWorkspaces();
        expect(output).toContain('new_ws');
    });

    test('getWorkspaceRoot returns correct paths', async () => {
        // 1. Current workspace
        const currentRoot = await jjService.getWorkspaceRoot();
        expect(fs.realpathSync.native(currentRoot)).toBe(fs.realpathSync.native(repo.path));

        // 2. Secondary workspace
        const wsPath = path.join(repo.path, 'ws_for_root');
        await jjService.workspaceAdd(wsPath, 'ws_for_root');
        const wsRoot = await jjService.getWorkspaceRoot('ws_for_root');
        expect(fs.realpathSync.native(wsRoot)).toBe(fs.realpathSync.native(wsPath));
    });

    test('workspaceForget removes workspace from tracking', async () => {
        const wsPath = path.join(repo.path, 'ws_to_forget');
        await jjService.workspaceAdd(wsPath, 'ws_to_forget');

        // Verify it exists in list
        let output = repo.listWorkspaces();
        expect(output).toContain('ws_to_forget');

        // Forget it
        await jjService.workspaceForget('ws_to_forget');

        // Verify it's gone from list
        output = repo.listWorkspaces();
        expect(output).not.toContain('ws_to_forget');

        // Directory should still exist (jj forget doesnt delete path)
        expect(fs.existsSync(wsPath)).toBe(true);
    });

    test('getWorkspaces returns all workspace names', async () => {
        await jjService.workspaceAdd(path.join(repo.path, 'ws1'), 'ws1');
        await jjService.workspaceAdd(path.join(repo.path, 'ws_colon'), 'ws:colon');
        await jjService.workspaceAdd(path.join(repo.path, 'ws-dash_under'), 'ws-dash_under');

        const workspaces = await jjService.getWorkspaces();
        expect(workspaces.map((w) => w.name).sort()).toEqual(['default', 'ws-dash_under', 'ws1', 'ws:colon']);
    });
});
