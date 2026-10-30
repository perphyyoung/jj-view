/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// sort-imports-ignore (needed so that we can import after `vscode` is mocked)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { handleTerminalExecution } from '../vscode/extension';

vi.mock('vscode', async () => {
    const { createVscodeMock } = await import('./vscode-mock');
    return createVscodeMock();
});

// Import after mock
import type { VsCodeScmProvider } from '../vscode/providers/vscode-scm-provider';
import { createMock, createMockLogOutputChannel } from './test-utils';

describe('handleTerminalExecution', () => {
    let outputChannel: vscode.LogOutputChannel;
    let scmProvider: VsCodeScmProvider;

    beforeEach(() => {
        outputChannel = createMockLogOutputChannel({ appendLine: vi.fn() });
        scmProvider = createMock<VsCodeScmProvider>({
            refresh: vi.fn().mockResolvedValue(undefined),
        });
    });

    it('detects "jj upload" and schedules a refresh', () => {
        const result = handleTerminalExecution('jj upload', outputChannel, scmProvider);

        expect(result).toBe(true);
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('detects "jj gerrit upload" with arguments', () => {
        const result = handleTerminalExecution('jj gerrit upload --change abc123', outputChannel, scmProvider);

        expect(result).toBe(true);
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('ignores non-jj commands', () => {
        const result = handleTerminalExecution('git push origin main', outputChannel, scmProvider);

        expect(result).toBe(false);
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    it('ignores jj commands without upload', () => {
        const result = handleTerminalExecution('jj log --revisions @', outputChannel, scmProvider);

        expect(result).toBe(false);
        expect(scmProvider.refresh).not.toHaveBeenCalled();
    });

    it('handles leading whitespace in command', () => {
        const result = handleTerminalExecution('  jj upload  ', outputChannel, scmProvider);

        expect(result).toBe(true);
        expect(scmProvider.refresh).toHaveBeenCalled();
    });

    it('logs detected upload command', () => {
        handleTerminalExecution('jj upload', outputChannel, scmProvider);

        expect(outputChannel.info).toHaveBeenCalledWith('[Extension] Detected terminal upload/push: "jj upload"');
    });
});
