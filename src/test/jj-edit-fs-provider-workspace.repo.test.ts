/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../core/uri-utils';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as fs from 'node:fs';
import * as path from 'node:path';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { VsCodeEditFsProvider } from '../vscode/providers/vscode-edit-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeEditFsProvider workspace lifecycle', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: VsCodeEditFsProvider;

    function getUri(filename: string, revision: string | null = '@') {
        const relPath = filename.startsWith('/') ? filename : `/${filename}`;
        const fragmentParams = new URLSearchParams();
        fragmentParams.set('root', repo.path);
        if (revision) {
            fragmentParams.set('revision', revision);
        }
        return Uri.from({
            scheme: 'jj-edit',
            path: relPath,
            fragment: fragmentParams.toString(),
        });
    }

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        const outputChannel = createMockLogOutputChannel({ appendLine: () => {} });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(outputChannel, host);
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        provider = new VsCodeEditFsProvider(new JjEditFsService(repoManager));
        provider.onDidChangeFile(() => {});

        await buildGraph(repo, [
            {
                label: 'base',
                isCurrentWorkingCopy: true,
                description: 'base commit',
                files: { 'file.txt': 'hello\n' },
            },
        ]);
    });

    afterEach(async () => {
        await repoManager?.dispose();
        repo?.dispose();
    });

    it('cancels pending timers and rejects pending writes on dispose', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'file.txt': 'commit1\n' } },
        ]);

        const uri = getUri('file.txt', ids.commit1.changeId);
        const writePromise = provider.writeFile(uri, Buffer.from('unflushed edit\n', 'utf8'));

        provider.dispose();

        await expect(writePromise).rejects.toThrow('JjEditFsService disposed');
    });

    it('handles reading and writing in a subfolder workspace', async () => {
        const subDir = path.join(repo.path, 'nested', 'pkg');
        fs.mkdirSync(subDir, { recursive: true });

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'nested/pkg/file.txt': 'sub initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'nested/pkg/file.txt': 'sub commit1\n' } },
        ]);

        const fragmentParams = new URLSearchParams();
        fragmentParams.set('root', subDir);
        fragmentParams.set('revision', ids.commit1.changeId);

        const subUri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: fragmentParams.toString(),
        });

        const readData = await provider.readFile(subUri);
        expect(Buffer.from(readData).toString('utf8')).toBe('sub commit1\n');

        await provider.writeFile(subUri, Buffer.from('sub updated\n', 'utf8'));

        const savedContent = repo.getFileContent(ids.commit1.changeId, 'nested/pkg/file.txt');
        expect(savedContent).toBe('sub updated\n');
    });

    it('returns pending write content when reading before or during flush', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial\n' } },
            { label: 'commit1', parents: ['base'], files: { 'file.txt': 'commit1\n' } },
        ]);

        const uri = getUri('file.txt', ids.commit1.changeId);
        const writePromise = provider.writeFile(uri, Buffer.from('new edited content\n', 'utf8'));

        const readImmediately = await provider.readFile(uri);
        expect(Buffer.from(readImmediately).toString('utf8')).toBe('new edited content\n');

        await writePromise;

        const readAfter = await provider.readFile(uri);
        expect(Buffer.from(readAfter).toString('utf8')).toBe('new edited content\n');
    });

    it('reconstructs absolute path from relative path URI with root fragment', async () => {
        const relUri = Uri.from({
            scheme: 'jj-edit',
            path: '/file.txt',
            fragment: `root=${encodeURIComponent(repo.path)}&revision=@`,
        });

        const content = await provider.readFile(relUri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
    });
});
