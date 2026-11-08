/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'pathe';
import type { Disposable, Event } from './host/events';
import type { JjRepository } from './jj-repository';
import type { JjRepositoryManager } from './jj-repository-manager';
import { type FileStatLike, getFsPathFromUri, getUriParams, Uri } from './uri-utils';
import { VirtualFsUriTracker } from './virtual-fs-uri-tracker';

export interface JjEditFsPendingWrite {
    revision: string;
    filePath: string;
    content: string;
    uri: Uri;
    resolve: () => void;
    reject: (err: unknown) => void;
}

export function parseEditUri(uri: Uri): { revision: string; filePath: string } {
    const params = getUriParams(uri);
    const revision = params.get('revision');
    if (!revision) {
        throw new Error('Missing revision in jj-edit URI');
    }
    const filePath = getFsPathFromUri(uri);
    return { revision, filePath };
}

const WRITE_FLUSH_DEBOUNCE_MS = 100;

/**
 * Gated diagnostics for the write pipeline. Enabled with `JJ_VIEW_DEBUG_EDIT=1`, which the
 * repo tests use when a write silently does not reach the target revision.
 */
function debugEditEnabled(): boolean {
    return process.env.JJ_VIEW_DEBUG_EDIT === '1';
}

function debugEdit(message: string): void {
    if (debugEditEnabled()) {
        process.stderr.write(`[JjEditFsService] ${message}\n`);
    }
}

/** Short, allocation-free fingerprint so logs can tell two contents apart without dumping them. */
function fingerprint(content: string): string {
    return `${content.length}:${content.slice(0, 24).replace(/\n/g, '\\n')}|${content.slice(-24).replace(/\n/g, '\\n')}`;
}

export class JjEditFsService implements Disposable {
    private readonly _uriTracker: VirtualFsUriTracker;
    readonly onDidChangeFile: Event<Uri[]>;

    private _pendingWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _activeWrites = new Map<string, JjEditFsPendingWrite[]>();
    private _isFlushing = false;
    private _writeTimer: NodeJS.Timeout | undefined;
    private _writeVersion = 0;
    private _isDisposed = false;

    constructor(
        private readonly _repositoryManager: JjRepositoryManager,
        public onDidWrite?: (repo: JjRepository) => void,
    ) {
        this._uriTracker = new VirtualFsUriTracker(this._repositoryManager);
        this.onDidChangeFile = this._uriTracker.onDidChangeFile;
    }

    watch(uri: Uri): Disposable {
        if (this._isDisposed) {
            return { dispose: () => {} };
        }
        return this._uriTracker.watch(uri);
    }

    dispose(): void {
        this._isDisposed = true;
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }
        for (const writes of this._pendingWrites.values()) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
        }
        for (const writes of this._activeWrites.values()) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
        }
        this._pendingWrites.clear();
        this._activeWrites.clear();
        this.onDidWrite = undefined;
        this._uriTracker.dispose();
    }

    invalidateCache(): Uri[] {
        if (this._isDisposed) {
            return [];
        }
        this._writeVersion++;
        return this._uriTracker.fireChangeEvents();
    }

    stat(_uri: Uri): FileStatLike {
        return {
            type: 1, // File
            ctime: 0,
            mtime: 1700000000000 + this._writeVersion,
            size: 0,
        };
    }

    private getPendingOrActiveContent(repoKey: string, revision: string, filePath: string): string | undefined {
        const normalizedPath = path.normalize(filePath);
        const isMatch = (w: JjEditFsPendingWrite) =>
            w.revision === revision && path.normalize(w.filePath) === normalizedPath;

        const pending = this._pendingWrites.get(repoKey)?.findLast(isMatch);
        if (pending) {
            return pending.content;
        }

        const active = this._activeWrites.get(repoKey)?.findLast(isMatch);
        return active?.content;
    }

    async readFile(uri: Uri): Promise<Uint8Array> {
        if (this._isDisposed) {
            throw new Error('JjEditFsService is disposed');
        }
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFsService] No Jujutsu repository resolved for URI: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }
        this._uriTracker.recordAccess(uri);

        const repoKey = repo.rootUri.fsPath;
        const inMemoryContent = this.getPendingOrActiveContent(repoKey, revision, filePath);
        debugEdit(
            `read enter rev=${revision} file=${path.basename(filePath)} repo=${path.basename(repoKey)} inMemory=${inMemoryContent !== undefined ? fingerprint(inMemoryContent) : 'MISS'}`,
        );
        if (inMemoryContent !== undefined) {
            debugEdit(`read branch=inMemory rev=${revision} out=${fingerprint(inMemoryContent)}`);
            return new TextEncoder().encode(inMemoryContent);
        }

        if (revision === '@') {
            try {
                if (repo.host.system?.fs) {
                    const bytes = await repo.host.system.fs.readBinaryFile(filePath);
                    const asString = new TextDecoder().decode(bytes);
                    debugEdit(`read branch=disk rev=@ out=${fingerprint(asString)}`);
                    return bytes;
                }
            } catch {
                // Fallback to jj file show if disk file is missing/unreadable
            }
        }

        const content = await repo.jj.getFileContent(filePath, revision);
        debugEdit(`read branch=jj rev=${revision} out=${fingerprint(content)}`);
        return new TextEncoder().encode(content);
    }

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
        if (this._isDisposed) {
            throw new Error('JjEditFsService is disposed');
        }
        const { revision, filePath } = parseEditUri(uri);
        const repo = this._repositoryManager.getRepositoryForUri(uri);
        if (!repo) {
            this._repositoryManager.outputChannel.info(
                `[JjEditFsService] No Jujutsu repository resolved for write: ${uri.toString()} (scheme: ${uri.scheme}, fsPath: ${filePath})`,
            );
            throw new Error(`No Jujutsu repository found for: ${filePath}`);
        }

        const repoKey = repo.rootUri.fsPath;
        const stringContent = new TextDecoder().decode(content);

        return new Promise<void>((resolve, reject) => {
            const pendingList = this._pendingWrites.get(repoKey) || [];
            pendingList.push({
                revision,
                filePath,
                content: stringContent,
                uri,
                resolve,
                reject,
            });
            this._pendingWrites.set(repoKey, pendingList);

            if (this._writeTimer) {
                clearTimeout(this._writeTimer);
            }
            this._writeTimer = setTimeout(() => {
                this._writeTimer = undefined;
                this._flushPendingWrites();
            }, WRITE_FLUSH_DEBOUNCE_MS);
        });
    }

    private async _flushRevisionWrites(
        repo: JjRepository,
        revision: string,
        revWrites: JjEditFsPendingWrite[],
    ): Promise<void> {
        try {
            const filesMap = new Map<string, string>();
            for (const w of revWrites) {
                filesMap.set(w.filePath, w.content);
            }

            debugEdit(
                `flush begin rev=${revision} writes=${revWrites.length} fingerprints=${[...filesMap.values()].map(fingerprint).join(' ;; ')}`,
            );

            await repo.jj.setFilesContent(revision, filesMap);
            debugEdit(`flush setFilesContent done rev=${revision}`);
            this._writeVersion++;

            this._uriTracker.fireDirectChangeEvents(revWrites.map((w) => w.uri));

            // Editing the working-copy revision must also land on disk: `readFile('@')` prefers
            // the file on disk, and users expect their editor buffer to match after a save.
            if (revision === '@') {
                const fileSystem = repo.host.system?.fs;
                if (fileSystem) {
                    for (const w of revWrites) {
                        await fileSystem.writeTextFile(w.filePath, w.content).catch((err: unknown) => {
                            this._repositoryManager.outputChannel.warn(
                                `[JjEditFsService] Failed to mirror @ write to disk (${w.filePath}): ${String(err)}`,
                            );
                        });
                    }
                }
            }

            // The diff cache is keyed by revision and holds the pre-write contents; readers that
            // run right after a flush would otherwise see the old file. Drop it so the next
            // read rebuilds from the settled repository state.
            await repo.jj.clearCache().catch(() => {});
            debugEdit(`flush cleared cache rev=${revision}`);

            for (const w of revWrites) {
                w.resolve();
            }
            debugEdit(`flush resolved rev=${revision} writes=${revWrites.length}`);

            if (this.onDidWrite) {
                try {
                    this.onDidWrite(repo);
                } catch (err: unknown) {
                    this._repositoryManager.outputChannel.error(
                        `[JjEditFsService] onDidWrite callback failed: ${String(err)}`,
                    );
                }
            }
        } catch (err: unknown) {
            debugEdit(`flush FAILED revision=${revision}: ${String(err)}`);
            for (const w of revWrites) {
                w.reject(err);
            }
        }
    }

    private _groupWritesByRevision(writes: JjEditFsPendingWrite[]): Map<string, JjEditFsPendingWrite[]> {
        const writesByRevision = new Map<string, JjEditFsPendingWrite[]>();
        for (const write of writes) {
            const list = writesByRevision.get(write.revision) || [];
            list.push(write);
            writesByRevision.set(write.revision, list);
        }
        return writesByRevision;
    }

    private async _flushRepoWrites(repoKey: string, writes: JjEditFsPendingWrite[]): Promise<void> {
        if (this._isDisposed) {
            for (const write of writes) {
                write.reject(new Error('JjEditFsService disposed'));
            }
            this._activeWrites.delete(repoKey);
            return;
        }

        try {
            const repo = this._repositoryManager.getRepositoryForUri(Uri.file(repoKey));
            if (!repo) {
                for (const write of writes) {
                    write.reject(new Error(`Repository no longer available: ${repoKey}`));
                }
                return;
            }

            const writesByRevision = this._groupWritesByRevision(writes);
            for (const [revision, revWrites] of writesByRevision) {
                await this._flushSingleRevision(repo, repoKey, revision, revWrites);
            }
        } catch (repoErr: unknown) {
            for (const write of writes) {
                write.reject(repoErr);
            }
        } finally {
            this._activeWrites.delete(repoKey);
        }
    }

    private async _flushSingleRevision(
        repo: JjRepository,
        repoKey: string,
        revision: string,
        revWrites: JjEditFsPendingWrite[],
    ): Promise<void> {
        if (this._isDisposed) {
            for (const w of revWrites) {
                w.reject(new Error('JjEditFsService disposed'));
            }
            return;
        }

        try {
            await this._flushRevisionWrites(repo, revision, revWrites);
        } finally {
            this._pruneActiveWrites(repoKey, revWrites);
        }
    }

    private _pruneActiveWrites(repoKey: string, completedWrites: JjEditFsPendingWrite[]): void {
        const activeList = this._activeWrites.get(repoKey);
        if (!activeList) {
            return;
        }
        const remaining = activeList.filter((w) => !completedWrites.includes(w));
        if (remaining.length > 0) {
            this._activeWrites.set(repoKey, remaining);
            return;
        }
        this._activeWrites.delete(repoKey);
    }

    private _schedulePendingWriteFlush(): void {
        if (this._isDisposed || this._pendingWrites.size === 0 || this._writeTimer) {
            return;
        }
        this._writeTimer = setTimeout(() => {
            this._writeTimer = undefined;
            this._flushPendingWrites();
        }, WRITE_FLUSH_DEBOUNCE_MS);
    }

    private async _flushPendingWrites(): Promise<void> {
        if (this._isFlushing || this._isDisposed) {
            debugEdit(
                `flush SKIPPED isFlushing=${this._isFlushing} disposed=${this._isDisposed} pending=${this._pendingWrites.size}`,
            );
            return;
        }
        debugEdit(`flush START pending=${[...this._pendingWrites.values()].reduce((n, list) => n + list.length, 0)}`);
        this._isFlushing = true;
        if (this._writeTimer) {
            clearTimeout(this._writeTimer);
            this._writeTimer = undefined;
        }

        try {
            if (this._pendingWrites.size === 0 || this._isDisposed) {
                return;
            }
            const writesByRepo = new Map(this._pendingWrites);
            this._pendingWrites.clear();
            this._activeWrites = writesByRepo;

            for (const [repoKey, writes] of writesByRepo) {
                if (this._isDisposed) {
                    break;
                }
                await this._flushRepoWrites(repoKey, writes);
            }
        } finally {
            this._activeWrites.clear();
            this._isFlushing = false;
            this._schedulePendingWriteFlush();
        }
    }
}
