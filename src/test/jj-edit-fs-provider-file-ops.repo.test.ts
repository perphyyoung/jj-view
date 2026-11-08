/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Uri } from '../core/uri-utils';
import { createVscodeMock } from './vscode-mock';

vi.mock('vscode', () => createVscodeMock());

import * as vscode from 'vscode';
import { JjEditFsService } from '../core/jj-edit-fs-service';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { VsCodeEditFsProvider } from '../vscode/providers/vscode-edit-fs-provider';
import { FakeHostEnvironment } from './fake-host-environment';
import { buildGraph, TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

describe('VsCodeEditFsProvider basics', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let provider: VsCodeEditFsProvider;
    let onDidChangeFileFired: vscode.FileChangeEvent[][] = [];

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

        const outputChannel = createMockLogOutputChannel({
            appendLine: () => {},
        });
        const host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        repoManager = new JjRepositoryManager(outputChannel, host);
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));

        const service = new JjEditFsService(repoManager);
        provider = new VsCodeEditFsProvider(service);
        provider.onDidChangeFile((events) => {
            onDidChangeFileFired.push(events);
        });
        onDidChangeFileFired = [];

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

    it('stat returns a default file stat', async () => {
        const uri = getUri('file.txt');
        const stat = await provider.stat(uri);
        expect(stat.type).toBe(vscode.FileType.File);
        expect(stat.size).toBe(0); // It just returns a default object
    });

    it('readFile reads content from a specific revision', async () => {
        const uri = getUri('file.txt');
        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello\n');
        expect(Buffer.from(content).toString('utf8')).toBe(repo.getFileContent('@', 'file.txt'));
    });

    it('readFile throws for missing file in revision', async () => {
        const uri = getUri('nonexistent.txt');
        await expect(provider.readFile(uri)).rejects.toThrow();
    });

    it('readFile throws for missing revision query param', async () => {
        const uri = getUri('file.txt', null);
        await expect(provider.readFile(uri)).rejects.toThrow('Missing revision');
    });

    it('writeFile modifies file in specific revision', async () => {
        const uri = getUri('file.txt');

        let writeTriggered = false;
        provider.onDidWrite = () => {
            writeTriggered = true;
        };

        const newContent = Buffer.from('hello world!\n', 'utf8');
        await provider.writeFile(uri, newContent);

        expect(writeTriggered).toBe(true);

        const content = await provider.readFile(uri);
        expect(Buffer.from(content).toString('utf8')).toBe('hello world!\n');

        expect(repo.getFileContent('@', 'file.txt')).toBe('hello world!\n');

        expect(onDidChangeFileFired.length).toBeGreaterThan(0);
        const lastBatch = onDidChangeFileFired[onDidChangeFileFired.length - 1];
        expect(lastBatch.length).toBe(1);
        expect(lastBatch[0].uri.toString()).toBe(uri.toString());
        expect(lastBatch[0].type).toBe(vscode.FileChangeType.Changed);
    });

    it('writeFile resolves after batching multiple writes', async () => {
        const uri1 = getUri('file.txt');
        const uri2 = getUri('other.txt');

        const newContent1 = Buffer.from('mod1', 'utf8');
        const newContent2 = Buffer.from('mod2', 'utf8');

        const writePromise1 = provider.writeFile(uri1, newContent1);
        const writePromise2 = provider.writeFile(uri2, newContent2);

        await Promise.all([writePromise1, writePromise2]);

        const content1 = await provider.readFile(uri1);
        const content2 = await provider.readFile(uri2);

        expect(Buffer.from(content1).toString('utf8')).toBe('mod1');
        expect(Buffer.from(content2).toString('utf8')).toBe('mod2');

        expect(repo.getFileContent('@', 'file.txt')).toBe('mod1');
        expect(repo.getFileContent('@', 'other.txt')).toBe('mod2');

        expect(onDidChangeFileFired.length).toBe(1); // They should be batched together
        const batch = onDidChangeFileFired[0];
        expect(batch.length).toBe(2);

        const uris = batch.map((e) => e.uri.toString());
        expect(uris.some((u) => u.includes('file.txt'))).toBe(true);
        expect(uris.some((u) => u.includes('other.txt'))).toBe(true);
    });
});
