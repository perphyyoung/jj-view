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

describe('VsCodeEditFsProvider cache and watch', () => {
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

    it('invalidateCache triggers onDidChangeFile for known URIs', async () => {
        const uri1 = getUri('file.txt');
        const uri2 = getUri('other.txt');

        const content1 = await provider.readFile(uri1);
        expect(Buffer.from(content1).toString('utf8')).toBe('hello\n');

        const content2 = await provider.readFile(uri2);
        expect(Buffer.from(content2).toString('utf8')).toBe('hello other\n');

        expect(onDidChangeFileFired.length).toBe(0);

        provider.invalidateCache();

        expect(onDidChangeFileFired.length).toBe(1);
        const batch = onDidChangeFileFired[0];
        expect(batch.length).toBe(2);

        const uris = batch.map((e) => e.uri.toString());
        expect(uris.some((u) => u.includes('file.txt'))).toBe(true);
        expect(uris.some((u) => u.includes('other.txt'))).toBe(true);

        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(1);
    });

    it('watch returns a disposable and keeps URI notified across invalidations', () => {
        const uri = getUri('file.txt');
        const vscodeUri = vscode.Uri.parse(uri.toString());
        const disposable = provider.watch(vscodeUri);
        expect(disposable).toHaveProperty('dispose');

        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(1);

        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(2);

        disposable.dispose();
        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(2);
    });

    it('watch disposable is idempotent and does not drop shared watchers', () => {
        const uri = getUri('file.txt');
        const vscodeUri = vscode.Uri.parse(uri.toString());
        const watcher1 = provider.watch(vscodeUri);
        const watcher2 = provider.watch(vscodeUri);

        watcher1.dispose();
        watcher1.dispose();

        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(1);

        watcher2.dispose();
        provider.invalidateCache();
        expect(onDidChangeFileFired.length).toBe(1);
    });
});
