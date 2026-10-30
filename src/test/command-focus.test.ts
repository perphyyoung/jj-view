/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { JjRepository } from '../core/jj-repository';
import { selectCommandRepository } from '../vscode/register-commands';

const focusedRepo = { rootUri: { fsPath: 'D:/py-code/jj-view' } } as unknown as JjRepository;
const editorRepo = { rootUri: { fsPath: 'D:/py-code' } } as unknown as JjRepository;
const focusedScm = { id: 'focused-scm' };
const editorScm = { id: 'editor-scm' };

function setup() {
    const resolveFromContext = vi.fn(() => ({ repo: editorRepo, scm: editorScm as never }));
    const lookupScmProvider = vi.fn((rootPath: string) =>
        rootPath === focusedRepo.rootUri.fsPath ? (focusedScm as never) : undefined,
    );
    return { resolveFromContext, lookupScmProvider };
}

describe('selectCommandRepository', () => {
    it('targets the focused repository for view-level commands (preserveFocus)', () => {
        const { resolveFromContext, lookupScmProvider } = setup();

        const resolved = selectCommandRepository({
            preserveFocus: true,
            focusedRepository: focusedRepo,
            lookupScmProvider,
            resolveFromContext,
        });

        expect(resolved?.repo).toBe(focusedRepo);
        expect(resolved?.scm).toBe(focusedScm);
        expect(resolveFromContext).not.toHaveBeenCalled();
    });

    it('falls back to context resolution when there is no focused repository', () => {
        const { resolveFromContext, lookupScmProvider } = setup();

        const resolved = selectCommandRepository({
            preserveFocus: true,
            focusedRepository: undefined,
            lookupScmProvider,
            resolveFromContext,
        });

        expect(resolved?.repo).toBe(editorRepo);
        expect(resolveFromContext).toHaveBeenCalledTimes(1);
    });

    it('resolves from context for regular commands', () => {
        const { resolveFromContext, lookupScmProvider } = setup();

        const resolved = selectCommandRepository({
            preserveFocus: false,
            focusedRepository: focusedRepo,
            lookupScmProvider,
            resolveFromContext,
        });

        expect(resolved?.repo).toBe(editorRepo);
        expect(lookupScmProvider).not.toHaveBeenCalled();
    });
});
