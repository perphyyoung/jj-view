<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->
<script lang="ts">
interface LineHistoryEntry {
    sha: string;
    author: string;
    date: string;
    summary: string;
    text?: string;
}

interface LineHistoryPayload {
    root: string;
    path: string;
    line: number;
    entries: LineHistoryEntry[];
}

interface VsCodeApi {
    postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const PAGE_SIZE = 10;
const vscode = acquireVsCodeApi();

function readInitial(): LineHistoryPayload | null {
    const el = document.getElementById('__INITIAL_STATE__');
    if (!el?.textContent) {
        return null;
    }
    try {
        return JSON.parse(el.textContent) as LineHistoryPayload;
    } catch {
        return null;
    }
}

let payload = $state<LineHistoryPayload | null>(readInitial());
let visible = $state(PAGE_SIZE);
let listEl = $state<HTMLDivElement | undefined>(undefined);

const visibleEntries = $derived(payload ? payload.entries.slice(0, visible) : []);
const remaining = $derived(payload ? Math.max(payload.entries.length - visible, 0) : 0);

function loadMore(): void {
    if (!payload) {
        return;
    }
    // Append only: the list element keeps its scroll position.
    visible = Math.min(visible + PAGE_SIZE, payload.entries.length);
}

function openEntry(entry: LineHistoryEntry): void {
    vscode.postMessage({ type: 'openEntry', sha: entry.sha });
}

function shortSha(sha: string): string {
    return sha.slice(0, 8);
}

$effect(() => {
    const onMessage = (event: MessageEvent): void => {
        const data = event.data as { type?: string; payload?: LineHistoryPayload } | undefined;
        if (data?.type === 'update' && data.payload) {
            payload = data.payload;
            visible = PAGE_SIZE;
            if (listEl) {
                listEl.scrollTop = 0;
            }
        }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
});
</script>

<div class="panel" data-testid="line-history-root">
    {#if payload}
        <header class="header">
            <span class="title">Line History</span>
            <span class="target">{payload.path}:{payload.line}</span>
            <span class="count">{payload.entries.length} commits</span>
        </header>

        <div class="list" bind:this={listEl} data-testid="line-history-list">
            {#each visibleEntries as entry (entry.sha)}
                <button
                    type="button"
                    class="row"
                    data-testid="line-history-row"
                    onclick={() => openEntry(entry)}
                >
                    <div class="row-main">
                        <span class="sha">{shortSha(entry.sha)}</span>
                        <span class="summary">{entry.summary}</span>
                    </div>
                    {#if entry.text}
                        <div class="row-text">{entry.text}</div>
                    {/if}
                    <div class="row-meta">{entry.author} · {entry.date.slice(0, 10)}</div>
                </button>
            {/each}
        </div>

        {#if remaining > 0}
            <footer class="footer">
                <button
                    type="button"
                    class="load-more"
                    data-testid="line-history-more"
                    onclick={loadMore}
                >
                    Load {Math.min(PAGE_SIZE, remaining)} more ({remaining} remaining)
                </button>
            </footer>
        {/if}
    {:else}
        <div class="empty">No line history.</div>
    {/if}
</div>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
    }

    .header {
        display: flex;
        align-items: baseline;
        gap: 10px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--vscode-panel-border);
        position: sticky;
        top: 0;
    }

    .title {
        font-weight: 600;
    }

    .target {
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-descriptionForeground);
    }

    .count {
        margin-left: auto;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
    }

    .list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }

    .row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        text-align: left;
        padding: 6px 14px;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
    }

    .row:hover,
    .row:focus-visible {
        background: var(--vscode-list-hoverBackground);
        outline: none;
    }

    .row-main {
        display: flex;
        gap: 8px;
        align-items: baseline;
    }

    .sha {
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-textLink-foreground);
    }

    .summary {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .row-text {
        font-family: var(--vscode-editor-font-family);
        color: var(--vscode-editor-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: 0.9;
    }

    .row-meta {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
    }

    .footer {
        padding: 8px 14px;
        border-top: 1px solid var(--vscode-panel-border);
    }

    .load-more {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none;
        padding: 4px 10px;
        cursor: pointer;
    }

    .load-more:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }

    .empty {
        padding: 16px;
        color: var(--vscode-descriptionForeground);
    }
</style>
