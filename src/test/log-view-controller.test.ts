/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { LogViewController } from '../core/controllers/log-view-controller';
import type { JjLogEntry } from '../core/jj-types';
import { FakeHostEnvironment } from './fake-host-environment';
import { createMock } from './test-utils';

/**
 * Pure controller state: the old repo-tier version registered a real jj repository only to
 * construct the controller. `LogViewController` only needs a host for these paths.
 */
describe('LogViewController state', () => {
    let fakeHost: FakeHostEnvironment;
    let controller: LogViewController;
    let postedMessages: unknown[];

    beforeEach(async () => {
        postedMessages = [];
        fakeHost = new FakeHostEnvironment();
        fakeHost.storage.update('jj-view.hiddenCommitActions', ['squash']);
        controller = new LogViewController(undefined, fakeHost, {
            messenger: {
                postMessage: (m) => postedMessages.push(m),
            },
        });
        // The stored hidden actions are loaded asynchronously in the constructor.
        await Promise.resolve();
    });

    it('manages commits and fires onDidUpdateCommits', () => {
        const updates: (readonly JjLogEntry[])[] = [];
        controller.onDidUpdateCommits((c) => updates.push(c));

        const dummyCommits: JjLogEntry[] = [
            createMock<JjLogEntry>({
                change_id: 'test-change-1',
                commit_id: 'test-commit-1',
                description: 'test commit',
                is_immutable: false,
                is_empty: false,
                conflict: false,
                bookmarks: [],
                tags: [],
                parents: [],
            }),
        ];

        controller.setCommits(dummyCommits);
        expect(updates.length).toBe(1);
        expect(controller.commits).toEqual(dummyCommits);
        expect(postedMessages.length).toBeGreaterThan(0);
    });

    it('manages commit selection and guards against identical selections', () => {
        const selections: (readonly string[])[] = [];
        controller.onDidChangeSelection((s) => selections.push(s));

        controller.setSelectedCommits(['c1', 'c2']);
        expect(selections.length).toBe(1);
        expect(controller.selectedCommitIds).toEqual(['c1', 'c2']);

        // Same selection should not fire event
        controller.setSelectedCommits(['c1', 'c2']);
        expect(selections.length).toBe(1);
    });

    it('toggles commit actions and filters invalid action strings', () => {
        expect(controller.hiddenActions).toEqual(['squash']);

        controller.toggleAction('squash');
        expect(controller.hiddenActions).toEqual([]);

        controller.toggleAction('squash');
        expect(controller.hiddenActions).toEqual(['squash']);

        // Invalid action is ignored
        controller.toggleAction('invalidAction');
        expect(controller.hiddenActions).toEqual(['squash']);
    });

    it('updates configuration values and broadcasts update', () => {
        controller.updateConfig({
            theme: 'compact',
            graphLabelAlignment: 'compact',
            minChangeIdLength: 5,
        });

        expect(controller.theme).toBe('compact');
        expect(controller.graphLabelAlignment).toBe('compact');
        expect(controller.minChangeIdLength).toBe(5);
    });

    it('automatically updates configuration when host.config fires onDidChangeConfiguration', () => {
        fakeHost.config.set('logTheme', 'compact');
        fakeHost.config.set('graphLabelAlignment', 'compact');
        fakeHost.config.set('minChangeIdLength', 8);

        expect(controller.theme).toBe('compact');
        expect(controller.graphLabelAlignment).toBe('compact');
        expect(controller.minChangeIdLength).toBe(8);
    });
});
