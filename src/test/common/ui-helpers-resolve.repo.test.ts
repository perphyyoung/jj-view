/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepository } from '../../core/host/ui-helpers';
import { JjRepositoryManager } from '../../core/jj-repository-manager';
import { Uri } from '../../core/uri-utils';
import { FakeHostEnvironment } from '../fake-host-environment';
import { TestRepo } from '../test-repo';
import { createMockLogOutputChannel } from '../test-utils';
import '../vitest-utils';

describe('ui-helpers resolveRepository', () => {
    let repo: TestRepo;
    let repoManager: JjRepositoryManager;
    let host: FakeHostEnvironment;

    beforeEach(async () => {
        repo = new TestRepo();
        repo.init();

        host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(repo.path));

        const outputChannel = createMockLogOutputChannel();

        repoManager = new JjRepositoryManager(outputChannel, host);
        await repoManager.maybeRegisterRepositoryContainingUri(Uri.file(repo.path));
    });

    afterEach(async () => {
        await repoManager.dispose();
    });

    it('resolves repository from activeUri', () => {
        const fileUri = Uri.file(path.join(repo.path, 'sub', 'file.txt'));
        const resolved = resolveRepository(repoManager, { activeUri: fileUri });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('resolves repository from custom jj-commit scheme activeUri', () => {
        const commitUri = Uri.from({
            scheme: 'jj-commit',
            path: '/Commit',
            fragment: `repoRoot=${encodeURIComponent(repo.path)}`,
        });
        const resolved = resolveRepository(repoManager, { activeUri: commitUri });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('resolves repository from args object containing rootUri', () => {
        const scmArg = { rootUri: Uri.file(repo.path) };
        const resolved = resolveRepository(repoManager, { args: [scmArg] });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('resolves repository from resource group argument with resourceStates', () => {
        const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
        const groupArg = { resourceStates: [{ resourceUri: fileUri }] };
        const resolved = resolveRepository(repoManager, { args: [groupArg] });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('resolves repository from direct URI argument in args', () => {
        const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
        const resolved = resolveRepository(repoManager, { args: [fileUri] });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('resolves repository from host.documents.getActiveDocumentUri', () => {
        const fileUri = Uri.file(path.join(repo.path, 'file.txt'));
        host.documents.setActiveDocument(fileUri);
        const resolved = resolveRepository(repoManager, {
            host,
        });

        expect(resolved).toBeDefined();
        expect(resolved?.rootUri.fsPath).toBeSameFsPath(repo.path);
    });

    it('falls back to focusedRepository if no active uri or args match', () => {
        const registered = repoManager.getRepositoryForUri(Uri.file(repo.path));
        repoManager.setFocusedRepository(registered);

        const resolved = resolveRepository(repoManager);
        expect(resolved).toBe(registered);
    });
});
