/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import path from 'pathe';
import * as vscode from 'vscode';
import type { CommitDetails, LineAnnotation } from '../../core/blame/line-blame';
import {
    type DiffChunkLike,
    findAnnotation,
    formatHoverMarkdown,
    formatLineBlameText,
    formatUncommittedHoverMarkdown,
    isUncommittedLine,
    type LineChange,
    lineBlameCacheKey,
    pickLineChange,
} from '../../core/blame/line-blame';
import type { JjRepository } from '../../core/jj-repository';
import type { JjRepositoryManager } from '../../core/jj-repository-manager';
import { parseDiff } from '../../core/patch-helper';
import type { LoggerChannel } from '../../utils/output-channel';

const DECORATION_COLOR = 'var(--vscode-editorCodeLens-foreground, rgba(153, 153, 153, 0.9))';
const MAX_TEXT_LENGTH = 120;
const MAX_CACHED_FILES = 64;

/**
 * GitLens-style current-line blame: whenever the cursor settles on a line, the commit
 * that last touched it is rendered at the end of that line.
 */
export class VsCodeLineBlameProvider implements vscode.Disposable {
    private readonly _decoration: vscode.TextEditorDecorationType;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _cache = new Map<string, LineAnnotation[] | undefined>();
    private readonly _detailsCache = new Map<string, CommitDetails | undefined>();
    private readonly _parentCache = new Map<string, LineAnnotation[] | undefined>();
    private readonly _diffCache = new Map<string, readonly DiffChunkLike[] | undefined>();
    private _timer: ReturnType<typeof setTimeout> | undefined;
    private _disposed = false;
    private _requestId = 0;

    constructor(
        private readonly _repositoryManager: JjRepositoryManager,
        private readonly _outputChannel?: LoggerChannel,
    ) {
        this._decoration = vscode.window.createTextEditorDecorationType({
            after: {
                color: DECORATION_COLOR,
                fontStyle: 'italic',
                margin: '0 0 0 2em',
            },
        });

        this._disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => this._schedule(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this._clearAll();
                if (editor) {
                    this._schedule(editor);
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                this._invalidate(event.document.uri.fsPath);
            }),
        );

        if (vscode.window.activeTextEditor) {
            this._schedule(vscode.window.activeTextEditor);
        }
    }

    public dispose(): void {
        this._disposed = true;
        this._requestId++;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = undefined;
        }
        this._clearAll();
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
        this._disposables.length = 0;
        this._decoration.dispose();
        this._cache.clear();
    }

    private _schedule(editor: vscode.TextEditor): void {
        if (this._disposed) {
            return;
        }
        const config = vscode.workspace.getConfiguration('jj-view');
        if (!config.get<boolean>('lineBlame.enabled', true)) {
            this._clearAll();
            return;
        }
        const delay = Math.max(0, config.get<number>('lineBlame.delay', 150) ?? 150);
        if (this._timer) {
            clearTimeout(this._timer);
        }
        this._timer = setTimeout(() => {
            this._timer = undefined;
            void this._update(editor);
        }, delay);
    }

    private async _update(editor: vscode.TextEditor): Promise<void> {
        const requestId = ++this._requestId;
        const document = editor.document;

        if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
            this._clearEditor(editor);
            return;
        }
        if (document.uri.scheme !== 'file') {
            this._clearEditor(editor);
            return;
        }

        const config = vscode.workspace.getConfiguration('jj-view');
        const maxFileLines = config.get<number>('lineBlame.maxFileLines', 5000) ?? 5000;
        if (document.lineCount > maxFileLines) {
            this._clearEditor(editor);
            return;
        }

        const repo = this._repositoryManager.getRepositoryForUri(document.uri);
        if (!repo) {
            this._clearEditor(editor);
            return;
        }
        const root = repo.rootUri.fsPath;
        const relativePath = path.relative(root, document.uri.fsPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..')) {
            this._clearEditor(editor);
            return;
        }

        // The `@` commit id must be resolved first: new commits (advance bookmark / new / squash)
        // swap `@` without touching the document, so it drives the annotation cache key.
        const workingCopyCommitId = await this._getWorkingCopyCommitId(repo, root);
        if (this._disposed || requestId !== this._requestId) {
            return;
        }

        const cacheKey = lineBlameCacheKey(root, document.uri.fsPath, document.version, workingCopyCommitId);
        let annotations = this._cache.get(cacheKey);
        if (!this._cache.has(cacheKey)) {
            try {
                annotations = await repo.jj.annotateFile(relativePath);
            } catch (error: unknown) {
                annotations = undefined;
                this._outputChannel?.debug?.(`[LineBlame] annotate failed for ${relativePath}: ${String(error)}`);
            }
            this._cache.set(cacheKey, annotations);
            this._trimCache();
        }

        if (this._disposed || requestId !== this._requestId) {
            return;
        }

        const line = editor.selection.active.line;
        const annotation = findAnnotation(annotations, line);
        if (!annotation) {
            this._clearEditor(editor);
            return;
        }
        const uncommitted = isUncommittedLine(annotation, workingCopyCommitId);
        const text = formatLineBlameText(annotation, { maxLength: MAX_TEXT_LENGTH, uncommitted });
        if (!text) {
            this._clearEditor(editor);
            return;
        }

        const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
        this._clearAll();
        editor.setDecorations(this._decoration, [{ range, renderOptions: { after: { contentText: text } } }]);

        if (!config.get<boolean>('lineBlame.showHover', true)) {
            return;
        }

        // The tooltip needs the full commit message, which cannot be part of the
        // one-record-per-line annotate output, so resolve it lazily and cache per commit.
        let markdown: string;
        const showDiff = config.get<boolean>('lineBlame.showLineDiff', true);
        const diff = showDiff ? await this._getLineChange(repo, annotation.commitId, relativePath, line) : undefined;
        if (this._disposed || requestId !== this._requestId) {
            return;
        }

        if (uncommitted) {
            const parentAnnotations = await this._getParentAnnotations(
                repo,
                root,
                document.version,
                relativePath,
                workingCopyCommitId,
            );
            const parentAnnotation = findAnnotation(parentAnnotations, line);
            const parentDetails = parentAnnotation
                ? await this._getCommitDetails(repo, parentAnnotation.commitId)
                : undefined;
            markdown = formatUncommittedHoverMarkdown(parentAnnotation, parentDetails, diff);
        } else {
            const details = await this._getCommitDetails(repo, annotation.commitId);
            markdown = formatHoverMarkdown(annotation, details, diff);
        }

        if (this._disposed || requestId !== this._requestId) {
            return;
        }
        const hover = new vscode.MarkdownString(markdown);
        hover.isTrusted = true;
        this._clearAll();
        editor.setDecorations(this._decoration, [
            { range, renderOptions: { after: { contentText: text } }, hoverMessage: hover },
        ]);
    }

    /**
     * Commit id of the working-copy commit (`@`), used to detect uncommitted lines.
     * Queried fresh every time: context-menu actions (advance bookmark / new / squash) swap
     * `@` without touching any document, so a cached id would go stale and misclassify lines.
     */
    private async _getWorkingCopyCommitId(repo: JjRepository, root: string): Promise<string | undefined> {
        try {
            return (await repo.jj.getLogEntry('@'))?.commit_id;
        } catch (error: unknown) {
            this._outputChannel?.debug?.(`[LineBlame] working copy lookup failed for ${root}: ${String(error)}`);
            return undefined;
        }
    }

    /** Annotations of the parent revision (`@-`), resolved lazily for uncommitted lines. */
    private async _getParentAnnotations(
        repo: JjRepository,
        root: string,
        documentVersion: number,
        relativePath: string,
        workingCopyCommitId: string | undefined,
    ): Promise<LineAnnotation[] | undefined> {
        const key = `@-|${root}|${relativePath}|${documentVersion}|${workingCopyCommitId ?? ''}`;
        if (this._parentCache.has(key)) {
            return this._parentCache.get(key);
        }

        let annotations: LineAnnotation[] | undefined;
        try {
            annotations = await repo.jj.annotateFile(relativePath, '@-');
        } catch (error: unknown) {
            this._outputChannel?.debug?.(`[LineBlame] parent annotate failed for ${relativePath}: ${String(error)}`);
        }

        this._parentCache.set(key, annotations);
        while (this._parentCache.size > MAX_CACHED_FILES) {
            const oldest = this._parentCache.keys().next();
            if (oldest.done) {
                break;
            }
            this._parentCache.delete(oldest.value);
        }
        return annotations;
    }

    private async _getCommitDetails(repo: JjRepository, commitId: string): Promise<CommitDetails | undefined> {
        if (this._detailsCache.has(commitId)) {
            return this._detailsCache.get(commitId);
        }

        // Prefer the dedicated `jj log -T description` call; fall back to the JSON log entry
        // in case the direct read fails (e.g. abbreviated/ambiguous revision).
        let description = await repo.jj.getCommitDescription(commitId);
        if (!description) {
            try {
                const [entry] = await repo.jj.getLog({ revision: commitId, limit: 1 });
                description = entry?.description?.trim() || undefined;
            } catch (error: unknown) {
                this._outputChannel?.info?.(
                    `[LineBlame] commit details lookup failed for ${commitId}: ${String(error)}`,
                );
            }
        }
        if (!description) {
            this._outputChannel?.info?.(`[LineBlame] no commit message resolved for ${commitId}`);
        }
        const details: CommitDetails | undefined = description ? { description } : undefined;

        this._detailsCache.set(commitId, details);
        while (this._detailsCache.size > MAX_CACHED_FILES) {
            const oldest = this._detailsCache.keys().next();
            if (oldest.done) {
                break;
            }
            this._detailsCache.delete(oldest.value);
        }
        return details;
    }

    /** Resolves the change of a single line, parsing (and caching) the file diff per revision. */
    private async _getLineChange(
        repo: JjRepository,
        revision: string,
        relativePath: string,
        zeroBasedLine: number,
    ): Promise<LineChange | undefined> {
        const key = `${revision}|${relativePath}`;
        if (!this._diffCache.has(key)) {
            let chunks: readonly DiffChunkLike[] | undefined;
            try {
                const output = await repo.jj.getFileDiff(revision, relativePath);
                chunks = output ? (parseDiff(output) as DiffChunkLike[]) : undefined;
            } catch (error: unknown) {
                chunks = undefined;
                this._outputChannel?.debug?.(`[LineBlame] diff lookup failed for ${relativePath}: ${String(error)}`);
            }
            this._diffCache.set(key, chunks);
            this._trimMap(this._diffCache);
        }

        const chunks = this._diffCache.get(key);
        return chunks ? pickLineChange(chunks, zeroBasedLine + 1) : undefined;
    }

    private _trimMap<T>(map: Map<string, T>): void {
        while (map.size > MAX_CACHED_FILES) {
            const oldest = map.keys().next();
            if (oldest.done) {
                return;
            }
            map.delete(oldest.value);
        }
    }

    private _trimCache(): void {
        while (this._cache.size > MAX_CACHED_FILES) {
            const oldest = this._cache.keys().next();
            if (oldest.done) {
                return;
            }
            this._cache.delete(oldest.value);
        }
    }

    private _invalidate(fsPath: string): void {
        // The working-copy commit id and diff both change with every edit.
        this._diffCache.clear();
        const suffix = `|${fsPath}|`;
        for (const key of [...this._cache.keys()]) {
            if (key.includes(suffix)) {
                this._cache.delete(key);
            }
        }
    }

    private _clearAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this._clearEditor(editor);
        }
    }

    private _clearEditor(editor: vscode.TextEditor): void {
        editor.setDecorations(this._decoration, []);
    }
}
