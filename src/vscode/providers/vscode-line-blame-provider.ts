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
import { buildBufferToCommitLineMap } from '../../core/blame/line-map';
import type { JjRepository } from '../../core/jj-repository';
import type { JjRepositoryManager } from '../../core/jj-repository-manager';
import { parseDiff } from '../../core/patch-helper';
import type { LoggerChannel } from '../../utils/output-channel';

const DECORATION_COLOR = 'var(--vscode-editorCodeLens-foreground, rgba(153, 153, 153, 0.9))';
const MAX_TEXT_LENGTH = 120;
const MAX_CACHED_FILES = 64;
/** How long the working-copy commit id is reused; it only drives the annotation cache key. */
const WORKING_COPY_TTL_MS = 1000;
/** Lines annotated around the cursor for large files (window = 2 * this + 1). */
const ANNOTATION_WINDOW_LINES = 1000;
/** How long a hover request waits for the full tooltip before falling back to the summary. */
const HOVER_WAIT_MS = 800;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitLens-style current-line blame: whenever the cursor settles on a line, the commit
 * that last touched it is rendered at the end of that line.
 */
export class VsCodeLineBlameProvider implements vscode.Disposable {
    private readonly _decoration: vscode.TextEditorDecorationType;
    /**
     * Tooltip markdown per document, keyed by the decorated line. The blame text is an
     * `after` decoration rendered outside its range, so decoration hovers never fire for
     * it; the registered hover provider serves the same markdown for the whole line.
     */
    private readonly _hoverByUri = new Map<
        string,
        { line: number; markdown: string; resolve?: () => Promise<string>; pending?: Promise<string> }
    >();
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _cache = new Map<string, LineAnnotation[] | undefined>();
    private readonly _detailsCache = new Map<string, CommitDetails | undefined>();
    private readonly _parentCache = new Map<string, LineAnnotation[] | undefined>();
    private readonly _diffCache = new Map<string, readonly DiffChunkLike[] | undefined>();
    private readonly _contentCache = new Map<string, string[] | undefined>();
    private _timer: ReturnType<typeof setTimeout> | undefined;
    private _disposed = false;
    private _requestId = 0;
    /** Last scheduled target, so column-only cursor moves do not restart the update. */
    private _lastTarget: { uri: string; version: number; line: number } | undefined;
    /** Short-lived working-copy commit id, see WORKING_COPY_TTL_MS. */
    private _workingCopy: { root: string; id: string | undefined; at: number } | undefined;

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
            // Keep the decoration glued to the end of the line. With the default
            // OpenOpen behavior the range end stays where it was when text is
            // appended, so the blame text would be rendered inside the line.
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });

        this._disposables.push(
            vscode.languages.registerHoverProvider(
                { scheme: 'file' },
                {
                    provideHover: (document, position) => this._provideHover(document, position),
                },
            ),
            vscode.window.onDidChangeTextEditorSelection((event) => this._schedule(event.textEditor, 'selection')),
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                this._clearAll();
                if (editor) {
                    this._schedule(editor, 'selection');
                }
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const docRepo = this._repositoryManager.getRepositoryForUri(event.document.uri);
                const docRelativePath = docRepo
                    ? path.relative(docRepo.rootUri.fsPath, event.document.uri.fsPath).replace(/\\/g, '/')
                    : '';
                this._invalidate(
                    event.document.uri.fsPath,
                    docRelativePath && !docRelativePath.startsWith('..') ? docRelativePath : undefined,
                );
                // Hide the blame while the document is being edited: a range that was
                // captured before the edit would paint the blame text inside the line.
                // The next update after the debounce delay renders it at the new line end.
                // In-flight updates are stopped by the document-version check in
                // _applyDecoration, so cancelling them here is not needed.
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document.uri.toString() !== event.document.uri.toString()) {
                        continue;
                    }
                    this._clearEditor(editor);
                    this._schedule(editor, 'document');
                }
            }),
        );

        if (vscode.window.activeTextEditor) {
            this._schedule(vscode.window.activeTextEditor, 'selection');
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
        this._hoverByUri.clear();
    }

    private _schedule(editor: vscode.TextEditor, kind: 'selection' | 'document' = 'selection'): void {
        if (this._disposed) {
            return;
        }
        const config = vscode.workspace.getConfiguration('jj-view');
        if (!config.get<boolean>('lineBlame.enabled', true)) {
            this._clearAll();
            return;
        }
        // Edits get a longer debounce than cursor moves: the blame is hidden while typing
        // and only the settled state is worth an annotate round trip.
        const delay =
            kind === 'document'
                ? Math.max(0, config.get<number>('lineBlame.documentDelay', 400) ?? 400)
                : Math.max(0, config.get<number>('lineBlame.delay', 150) ?? 150);

        const document = editor.document;
        const line = editor.selection.active.line;
        const target = { uri: document.uri.toString(), version: document.version, line };
        if (
            kind === 'selection' &&
            this._lastTarget?.uri === target.uri &&
            this._lastTarget.version === target.version &&
            this._lastTarget.line === target.line
        ) {
            // Moving inside the same line must not cancel the hover work in flight.
            return;
        }
        this._lastTarget = target;

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
        // Guards every decoration against being applied to a document that changed while
        // this update was awaiting jj.
        const version = document.version;
        // Phase timings, emitted as a single debug line so slow tooltips can be traced.
        const updateStart = Date.now();
        const timings: string[] = [];
        let lapStart = updateStart;
        const lap = (label: string): void => {
            const now = Date.now();
            timings.push(`${label}=${now - lapStart}ms`);
            lapStart = now;
        };

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
        // It is cached briefly (see _getWorkingCopyCommitId) so hovering does not re-run it.
        const workingCopyCommitId = await this._getWorkingCopyCommitId(repo, root);
        lap('wcId');
        if (this._disposed || requestId !== this._requestId) {
            return;
        }

        const line = editor.selection.active.line;
        const contentSignature = await this._contentSignature(document);
        // Large files are annotated around the cursor only: the output no longer grows with
        // the file, while moving inside the window still reuses the cached annotations.
        const window = this._annotationWindow(document, line);
        const cacheSignature = window ? `${contentSignature}#${window.from}-${window.to}` : contentSignature;
        const cacheKey = lineBlameCacheKey(root, document.uri.fsPath, cacheSignature, workingCopyCommitId);
        const cached = this._cache.has(cacheKey);
        let annotations = this._cache.get(cacheKey);
        const annotateStart = Date.now();
        if (!cached) {
            // Reads are not serialized with mutations, so a read issued while a refresh is
            // snapshotting the working copy would fight for the jj repository lock. Back off
            // and retry instead of joining that contention. Cached annotations never need
            // this wait.
            if (repo.activeRefresh) {
                this._outputChannel?.debug?.('[LineBlame] repository refresh in flight, deferring update');
                this._schedule(editor);
                return;
            }
            if (!(await repo.jj.whenIdle())) {
                this._outputChannel?.debug?.(`[LineBlame] repository busy, deferring update (${timings.join(' ')})`);
                this._schedule(editor);
                return;
            }
            lap('whenIdle');
            if (this._disposed || requestId !== this._requestId) {
                return;
            }
            try {
                annotations = await repo.jj.annotateFile(relativePath, '@', window);
            } catch (error: unknown) {
                annotations = undefined;
                this._outputChannel?.debug?.(`[LineBlame] annotate failed for ${relativePath}: ${String(error)}`);
            }
            this._cache.set(cacheKey, annotations);
            this._trimCache();
            this._outputChannel?.debug?.(
                `[LineBlame] annotate ${relativePath} took ${Date.now() - annotateStart}ms (cached: false)`,
            );
        }
        lap(cached ? 'annotate(cached)' : 'annotate');

        if (this._disposed || requestId !== this._requestId) {
            return;
        }

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

        // The tooltip starts from the annotation alone and is upgraded on demand: resolving
        // the commit message and the line diff takes a few jj calls, so it only happens when
        // someone actually hovers (see _provideHover).
        const showHover = config.get<boolean>('lineBlame.showHover', true);
        const summaryMarkdown = uncommitted
            ? formatUncommittedHoverMarkdown(undefined)
            : formatHoverMarkdown(annotation);
        this._applyDecoration(
            editor,
            line,
            text,
            showHover
                ? {
                      markdown: summaryMarkdown,
                      resolve: () =>
                          this._resolveHoverMarkdown(
                              repo,
                              root,
                              relativePath,
                              annotation,
                              uncommitted,
                              workingCopyCommitId,
                              contentSignature,
                              window,
                              line,
                              document,
                          ),
                  }
                : undefined,
            version,
        );
        this._outputChannel?.debug?.(
            `[LineBlame] update ${relativePath} | ${timings.join(' | ')} | total=${Date.now() - updateStart}ms`,
        );
    }

    /**
     * Applies the blame decoration, always computing the range from the current
     * document: VS Code renders the `after` text at the end of the range, so a range
     * captured before an await would paint the blame text inside the line.
     */
    private _applyDecoration(
        editor: vscode.TextEditor,
        line: number,
        text: string,
        hover?: { markdown: string; resolve?: () => Promise<string> },
        expectedVersion?: number,
    ): void {
        const document = editor.document;
        if (expectedVersion !== undefined && document.version !== expectedVersion) {
            // The document changed while this update was awaiting jj: the range and the
            // text are both stale, so drop the result instead of painting it.
            return;
        }
        if (line < 0 || line >= document.lineCount) {
            return;
        }
        const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
        const decoration: vscode.DecorationOptions = { range, renderOptions: { after: { contentText: text } } };
        this._clearAll();
        editor.setDecorations(this._decoration, [decoration]);
        if (hover === undefined) {
            this._hoverByUri.delete(document.uri.toString());
        } else {
            this._hoverByUri.set(document.uri.toString(), { line, markdown: hover.markdown, resolve: hover.resolve });
        }
    }

    /**
     * Serves the blame tooltip for the decorated line. The blame text itself is an `after`
     * decoration rendered outside its range, so decoration hover messages never fire when
     * the pointer is over the blame text; answering for the whole line covers both.
     *
     * The full tooltip is resolved here, on demand: VS Code does not re-render a tooltip
     * that is already visible, so showing a placeholder and upgrading it later would leave
     * the user with stale content until the mouse moves.
     */
    private async _provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | undefined> {
        const entry = this._hoverByUri.get(document.uri.toString());
        if (!entry || entry.line !== position.line) {
            return undefined;
        }
        if (!entry.pending && entry.resolve) {
            const resolve = entry.resolve;
            entry.resolve = undefined;
            entry.pending = resolve().then(
                (markdown) => markdown,
                () => entry.markdown,
            );
        }
        if (entry.pending) {
            const resolved = await Promise.race([entry.pending, delay(HOVER_WAIT_MS).then(() => undefined)]);
            if (typeof resolved === 'string' && resolved.length > 0) {
                entry.markdown = resolved;
                entry.pending = undefined;
            }
        }
        const markdown = new vscode.MarkdownString(entry.markdown);
        markdown.isTrusted = true;
        return new vscode.Hover(markdown, document.lineAt(entry.line).range);
    }

    /** Builds the full tooltip: line diff plus the complete commit message. */
    private async _resolveHoverMarkdown(
        repo: JjRepository,
        root: string,
        relativePath: string,
        annotation: LineAnnotation,
        uncommitted: boolean,
        workingCopyCommitId: string | undefined,
        contentSignature: string,
        window: { from: number; to: number } | undefined,
        line: number,
        document: vscode.TextDocument,
    ): Promise<string> {
        const start = Date.now();
        const config = vscode.workspace.getConfiguration('jj-view');
        const showDiff = config.get<boolean>('lineBlame.showLineDiff', true);
        let markdown: string;
        if (uncommitted) {
            const [diff, parentAnnotations] = await Promise.all([
                showDiff ? this._getLineChange(repo, annotation.commitId, relativePath, line, document) : undefined,
                this._getParentAnnotations(repo, root, contentSignature, relativePath, workingCopyCommitId, window),
            ]);
            const parentAnnotation = findAnnotation(parentAnnotations, line);
            const parentDetails = parentAnnotation
                ? await this._getCommitDetails(repo, parentAnnotation.commitId)
                : undefined;
            markdown = formatUncommittedHoverMarkdown(parentAnnotation, parentDetails, diff);
        } else {
            const [diff, details] = await Promise.all([
                showDiff ? this._getLineChange(repo, annotation.commitId, relativePath, line, document) : undefined,
                this._getCommitDetails(repo, annotation.commitId),
            ]);
            markdown = formatHoverMarkdown(annotation, details, diff);
        }
        this._outputChannel?.debug?.(`[LineBlame] hover resolved in ${Date.now() - start}ms`);
        return markdown;
    }

    /**
     * Commit id of the working-copy commit (`@`), used to detect uncommitted lines.
     * Cached for WORKING_COPY_TTL_MS: context-menu actions (advance bookmark / new / squash)
     * swap `@` without touching any document, so the cache is deliberately short-lived.
     */
    private async _getWorkingCopyCommitId(repo: JjRepository, root: string): Promise<string | undefined> {
        const now = Date.now();
        if (this._workingCopy && this._workingCopy.root === root && now - this._workingCopy.at < WORKING_COPY_TTL_MS) {
            return this._workingCopy.id;
        }
        try {
            const id = (await repo.jj.getLogEntry('@'))?.commit_id;
            this._workingCopy = { root, id, at: Date.now() };
            return id;
        } catch (error: unknown) {
            this._outputChannel?.debug?.(`[LineBlame] working copy lookup failed for ${root}: ${String(error)}`);
            return undefined;
        }
    }

    /**
     * Signature of the content `jj file annotate` would read. The editor version changes
     * on every keystroke while the file on disk stays the same, so keying the annotation
     * cache by version would re-run annotate for nothing on each edit.
     */
    private async _contentSignature(document: vscode.TextDocument): Promise<string> {
        try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            return `${stat.mtime}:${stat.size}`;
        } catch {
            return `v${document.version}`;
        }
    }

    /**
     * Annotation window for large files: jj always blames the whole file, but only the
     * lines around the cursor are emitted, so the transferred and parsed output stays
     * bounded. Small files are annotated in full.
     */
    private _annotationWindow(document: vscode.TextDocument, line: number): { from: number; to: number } | undefined {
        if (document.lineCount <= ANNOTATION_WINDOW_LINES * 2 + 1) {
            return undefined;
        }
        return {
            from: Math.max(1, line + 1 - ANNOTATION_WINDOW_LINES),
            to: Math.min(document.lineCount, line + 1 + ANNOTATION_WINDOW_LINES),
        };
    }

    /** Annotations of the parent revision (`@-`), resolved lazily for uncommitted lines. */
    private async _getParentAnnotations(
        repo: JjRepository,
        root: string,
        contentSignature: string,
        relativePath: string,
        workingCopyCommitId: string | undefined,
        window?: { from: number; to: number },
    ): Promise<LineAnnotation[] | undefined> {
        const windowKey = window ? `#${window.from}-${window.to}` : '';
        const key = `@-|${root}|${relativePath}|${contentSignature}${windowKey}|${workingCopyCommitId ?? ''}`;
        if (this._parentCache.has(key)) {
            return this._parentCache.get(key);
        }

        let annotations: LineAnnotation[] | undefined;
        try {
            annotations = await repo.jj.annotateFile(relativePath, '@-', window);
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
        document: vscode.TextDocument,
    ): Promise<LineChange | undefined> {
        const chunks = await this._getDiffChunks(repo, revision, relativePath);
        if (!chunks) {
            return undefined;
        }

        // The hunks use the line numbers of the file at that commit. Looking the buffer line
        // up directly is not enough: a commit that added/rewrote the whole file produces a
        // hunk spanning every line, so an unrelated line of that commit answers. Always map
        // the buffer line onto the committed version first (the mapping uses the buffer text,
        // so unsaved edits are fine too).
        const commitLines = await this._getCommitContent(repo, revision, relativePath);
        if (!commitLines) {
            return undefined;
        }
        const bufferToCommit = buildBufferToCommitLineMap(commitLines, document.getText().split('\n'));
        const commitLine = bufferToCommit.get(zeroBasedLine);
        if (commitLine === undefined) {
            this._outputChannel?.debug?.(`[LineBlame] diff miss ${relativePath}:${zeroBasedLine + 1} (rewritten line)`);
            return undefined;
        }
        return pickLineChange(chunks, commitLine + 1);
    }

    private async _getDiffChunks(
        repo: JjRepository,
        revision: string,
        relativePath: string,
    ): Promise<readonly DiffChunkLike[] | undefined> {
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
        return this._diffCache.get(key);
    }

    /** File content at a commit, cached: a commit never changes once it is created. */
    private async _getCommitContent(
        repo: JjRepository,
        revision: string,
        relativePath: string,
    ): Promise<string[] | undefined> {
        const key = `${revision}|${relativePath}`;
        if (this._contentCache.has(key)) {
            return this._contentCache.get(key);
        }
        let lines: string[] | undefined;
        try {
            const content = await repo.jj.cat(relativePath, revision);
            lines = content.split('\n');
        } catch (error: unknown) {
            lines = undefined;
            this._outputChannel?.debug?.(`[LineBlame] content lookup failed for ${relativePath}: ${String(error)}`);
        }
        this._contentCache.set(key, lines);
        this._trimMap(this._contentCache);
        return lines;
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

    private _invalidate(fsPath: string, relativePath?: string): void {
        const suffix = `|${fsPath}|`;
        for (const key of [...this._cache.keys()]) {
            if (key.includes(suffix)) {
                this._cache.delete(key);
            }
        }
        // Only this file's diffs can change; dropping the whole cache would force every
        // other file to re-run `jj diff` on its next hover.
        if (!relativePath) {
            this._diffCache.clear();
            return;
        }
        const diffSuffix = `|${relativePath}`;
        for (const key of [...this._diffCache.keys()]) {
            if (key.endsWith(diffSuffix)) {
                this._diffCache.delete(key);
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
        this._hoverByUri.delete(editor.document.uri.toString());
    }
}
