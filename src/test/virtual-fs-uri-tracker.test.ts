/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { JjRepository } from '../core/jj-repository';
import type { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { VirtualFsUriTracker } from '../core/virtual-fs-uri-tracker';
import { createMock } from './test-utils';

/**
 * Pure tracker state: the old repo-tier version created a real jj repository only so
 * `getRepositoryForUri` could say "inside" or "outside". A stub is enough here.
 */
const root = Uri.file('/repo').fsPath;

const manager = createMock<JjRepositoryManager>({
    getRepositoryForUri: (uri: Uri) =>
        uri.fsPath.toLowerCase().startsWith(root.toLowerCase()) ? ({} as JjRepository) : undefined,
});

describe('VirtualFsUriTracker', () => {
    let tracker: VirtualFsUriTracker;

    beforeEach(() => {
        tracker = new VirtualFsUriTracker(manager);
    });

    it('records accessed URIs and notifies on fireChangeEvents', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${root}/file.txt`);
        tracker.recordAccess(uri);

        const notified = tracker.fireChangeEvents();
        expect(notified.length).toBe(1);
        expect(notified[0].fsPath).toBeSameFsPath(uri.fsPath);
        expect(events.length).toBe(1);

        expect(tracker.fireChangeEvents().length).toBe(0);
        expect(events.length).toBe(1);
    });

    it('manages watcher reference counting across multiple watch tokens', () => {
        const uri = Uri.file(`${root}/file.txt`);
        let fireCount = 0;
        tracker.onDidChangeFile(() => fireCount++);

        const watcher1 = tracker.watch(uri);
        const watcher2 = tracker.watch(uri);

        tracker.fireChangeEvents();
        expect(fireCount).toBe(1);

        watcher1.dispose();
        tracker.fireChangeEvents();
        expect(fireCount).toBe(2);

        watcher2.dispose();
        tracker.fireChangeEvents();
        expect(fireCount).toBe(2);
    });

    it('disposal of watcher token is idempotent', () => {
        const watcher = tracker.watch(Uri.file(`${root}/file.txt`));
        expect(() => {
            watcher.dispose();
            watcher.dispose();
        }).not.toThrow();
    });

    it('fires direct change events immediately', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${root}/direct.txt`);
        tracker.fireDirectChangeEvents([uri]);

        expect(events.length).toBe(1);
        expect(events[0][0].fsPath).toBeSameFsPath(uri.fsPath);
    });

    it('ignores operations when disposed', () => {
        tracker.dispose();

        const uri = Uri.file(`${root}/file.txt`);
        tracker.recordAccess(uri);
        const watcher = tracker.watch(uri);
        expect(() => watcher.dispose()).not.toThrow();
        expect(tracker.fireChangeEvents().length).toBe(0);
    });

    it('deduplicates URIs in fireDirectChangeEvents', () => {
        const events: Uri[][] = [];
        tracker.onDidChangeFile((uris) => events.push(uris));

        const uri = Uri.file(`${root}/direct.txt`);
        tracker.fireDirectChangeEvents([uri, uri, Uri.file(`${root}/direct.txt`)]);

        expect(events.length).toBe(1);
        expect(events[0].length).toBe(1);
        expect(events[0][0].fsPath).toBeSameFsPath(uri.fsPath);
    });

    it('disposing watcher token after tracker disposal does not throw', () => {
        const watcher = tracker.watch(Uri.file(`${root}/file.txt`));
        tracker.dispose();
        expect(() => watcher.dispose()).not.toThrow();
    });

    it('filters out URIs that do not belong to any registered repository', () => {
        tracker.recordAccess(Uri.file('/outside/non-existent-repo/file.txt'));
        expect(tracker.fireChangeEvents().length).toBe(0);
    });
});
