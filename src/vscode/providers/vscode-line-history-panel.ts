/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import * as vscode from 'vscode';
import { type LineHistoryPanelPayload, shortSha } from '../../core/blame/line-history';
import { createRevisionUri } from '../../core/uri-utils';
import { getWebviewHtml } from '../vscode-webview-html';

let extensionUri: vscode.Uri | undefined;
let panel: vscode.WebviewPanel | undefined;

export function initLineHistoryPanel(uri: vscode.Uri): void {
    extensionUri = uri;
}

function panelTitle(payload: LineHistoryPanelPayload): string {
    return `Line History: ${path.basename(payload.path)}:${payload.line}`;
}

/**
 * Opens (or retargets) the Line History tab.
 *
 * One panel per window: calling it again for another line reuses the tab and pushes fresh
 * data, so the editor does not accumulate tabs. Paging happens inside the webview, which
 * keeps the list's scroll position.
 */
export function openLineHistoryPanel(payload: LineHistoryPanelPayload): void {
    if (!extensionUri) {
        return;
    }
    if (panel) {
        panel.title = panelTitle(payload);
        panel.reveal(undefined, true);
        void panel.webview.postMessage({ type: 'update', payload });
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'jj-view.lineHistoryPanel',
        panelTitle(payload),
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
        },
    );
    panel.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
    panel.webview.html = getWebviewHtml({
        webview: panel.webview,
        extensionUri,
        scriptPath: ['dist', 'webview', 'line-history.js'],
        title: 'Line History',
        initialData: payload,
    });

    const subscriptions = [
        panel.webview.onDidReceiveMessage((message: unknown) => {
            void handleMessage(payload, message);
        }),
        panel.onDidDispose(() => {
            panel = undefined;
            for (const subscription of subscriptions) {
                subscription.dispose();
            }
        }),
    ];
}

async function handleMessage(payload: LineHistoryPanelPayload, message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') {
        return;
    }
    const record = message as { type?: string; sha?: string };
    if (record.type === 'ready') {
        void panel?.webview.postMessage({ type: 'update', payload });
        return;
    }
    if (record.type === 'openEntry' && record.sha) {
        await openEntryDiff(payload, record.sha);
    }
}

async function openEntryDiff(payload: LineHistoryPanelPayload, sha: string): Promise<void> {
    const absolutePath = path.join(payload.root, payload.path);
    const left = createRevisionUri(payload.root, absolutePath, `parents(${sha})`);
    const right = createRevisionUri(payload.root, absolutePath, sha);
    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(payload.path)} @ ${shortSha(sha)}`,
        { preview: true, preserveFocus: true },
    );
}
