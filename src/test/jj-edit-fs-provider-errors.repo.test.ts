/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../core/uri-utils';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { VsCodeEditFsProvider } from '../vscode/providers/vscode-edit-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeEditFsProvider error handling', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: VsCodeEditFsProvider;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(outputChannel, host);
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        const service = new JjEditFsService(repoManager);
        provider = new VsCodeEditFsProvider(service);

        await buildGraph(repo, [
            {
                label: 'base',
                isCurrentWorkingCopy: true,
                description: 'base commit',
                files: { 'file.txt': 'hello\n', 'other.txt': 'hello other\n' },
            },
        ]);
    });

    afterEach(async () => {
        await repoManager?.dispose();
        repo?.dispose();
    });

    it('readFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.readFile(outsideUri)).rejects.toThrowError('No Jujutsu repository found');
    });

    it('writeFile throws FileSystemError.Unavailable when no repository is found', async () => {
        const outsideUri = Uri.parse('jj-edit:///outside/file.txt#root=/outside&revision=@');
        await expect(provider.writeFile(outsideUri, Buffer.from('content'))).rejects.toThrowError(
            'No Jujutsu repository found',
        );
    });

    it('unsupported operations throw', () => {
        expect(() => provider.readDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.createDirectory()).toThrow('jj-edit is file-only');
        expect(() => provider.delete()).toThrow('jj-edit does not support delete');
        expect(() => provider.rename()).toThrow('jj-edit does not support rename');
    });
});
