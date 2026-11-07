/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { type LineHistoryPayload, normalizeLineHistoryPayload } from '../../core/commands/line-history';
import type { VsCodeScmProvider } from '../providers/vscode-scm-provider';

/**
 * Builds the payload for `jj-view.lineHistory`.
 *
 * The editor context menu passes `{fileName, lineNumber}` in some versions and only a URI in
 * others, so anything not covered by the raw argument falls back to the active editor. Without
 * this the command received an empty payload and only showed a toast.
 */
export function createLineHistoryPayload(args: unknown[], scm?: VsCodeScmProvider): LineHistoryPayload | undefined {
    const editor = vscode.window.activeTextEditor;
    const fallback = {
        fileName: editor?.document.uri.fsPath,
        lineNumber: editor?.selection.active.line,
    };
    const first = args[0];
    if (first && typeof first === 'object' && 'fsPath' in first && 'scheme' in first) {
        const uri = first as { fsPath: string; scheme: string };
        if (uri.scheme === 'file') {
            fallback.fileName = uri.fsPath;
        }
    }
    return normalizeLineHistoryPayload(first, fallback, scm?.repo.rootUri.fsPath);
}
