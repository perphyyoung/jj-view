/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showJjError } from '../../core/host/ui-helpers';
import { JjService, NO_OP_LOGGER } from '../../core/jj-service';
import { FakeHostUi } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMockLogOutputChannel } from '../test-utils';

describe('ui-helpers showJjError', () => {
    let repo: TestRepo;
    let jj: JjService;
    let ui: FakeHostUi;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jj = new JjService(repo.path, NO_OP_LOGGER);
        ui = new FakeHostUi();
    });

    it('displays error message and logs error', async () => {
        const log = createMockLogOutputChannel();
        ui.showErrorMessage = vi.fn().mockResolvedValue(undefined);

        const err = new Error('Working copy is dirty');
        await showJjError(ui, err, 'Commit Error', jj, log);

        expect(log.error).toHaveBeenCalledWith('Commit Error: Working copy is dirty', err);
        expect(ui.showErrorMessage).toHaveBeenCalledWith('Commit Error: Working copy is dirty', 'Show Log');
    });

    it('opens log when Show Log action is selected', async () => {
        const log = createMockLogOutputChannel();
        ui.setNextErrorResponse('Show Log');

        const err = new Error('Something failed');
        const result = await showJjError(ui, err, 'Error', jj, log);

        expect(result).toBe('Show Log');
        expect(log.show).toHaveBeenCalled();
    });

    it('passes extra actions and returns selected extra action', async () => {
        const log = createMockLogOutputChannel();
        ui.setNextErrorResponse('Configure Upload...');

        const err = new Error('No upload command');
        const result = await showJjError(ui, err, 'Upload Error', jj, log, ['Configure Upload...']);

        expect(result).toBe('Configure Upload...');
    });

    it('detects Git index lock error and deletes lock file when chosen', async () => {
        const log = createMockLogOutputChannel();
        const lockPath = path.join(repo.path, '.git', 'index.lock');
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, '');

        ui.setNextErrorResponse('Delete Lock File');

        const err = new Error('Could not acquire lock for index file');
        const result = await showJjError(ui, err, 'Git Error', jj, log);

        expect(result).toBe('Delete Lock File');
        expect(fs.existsSync(lockPath)).toBe(false);
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Deleted lock file'));
    });
});
