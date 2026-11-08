/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';

describe('JjService Diff Tests', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    afterEach(() => {});

    test('getChangesBetween correctly calculates net changes across complex diamond merge graph', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'root',
                files: {
                    'shared.txt': 'root shared\n',
                    'common.txt': 'root common\n',
                    'deleted_in_merge.txt': 'to be deleted\n',
                    'nested/deep_file.txt': 'original deep\n',
                },
            },
            {
                label: 'featureA',
                parents: ['root'],
                files: { 'common.txt': 'featureA common\n', 'feature_a.txt': 'added in A\n' },
            },
            {
                label: 'featureA2',
                parents: ['featureA'],
                files: { 'shared.txt': 'featureA2 shared\n' },
            },
            {
                label: 'featureB',
                parents: ['root'],
                files: {
                    'common.txt': 'featureB common\n',
                    'feature_b.txt': 'added in B\n',
                    'path with space/file.txt': 'space file\n',
                },
            },
            {
                label: 'featureB2',
                parents: ['featureB'],
                files: { 'path with space/file.txt': 'space file modified\n' },
            },
            {
                label: 'merge',
                parents: ['featureA2', 'featureB2'],
                files: { 'common.txt': 'resolved common\n' },
            },
        ]);

        repo.edit(ids.featureA2.changeId);
        repo.deleteFile('deleted_in_merge.txt');

        // 1. Compare root vs merge across the diamond graph
        const changesVsRoot = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);
        changesVsRoot.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesVsRoot).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'deleted_in_merge.txt', status: 'deleted', conflicted: false },
            { path: 'feature_a.txt', status: 'added', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
            { path: 'shared.txt', status: 'modified', conflicted: false },
        ]);

        // 2. Compare divergent sibling branches (featureA vs featureB2)
        const changesDivergent = await jjService.getChangesBetween(ids.featureA.changeId, ids.featureB2.changeId);
        changesDivergent.sort((a, b) => a.path.localeCompare(b.path));

        expect(changesDivergent).toEqual([
            { path: 'common.txt', status: 'modified', conflicted: false },
            { path: 'feature_a.txt', status: 'deleted', conflicted: false },
            { path: 'feature_b.txt', status: 'added', conflicted: false },
            { path: 'path with space/file.txt', status: 'added', conflicted: false },
        ]);
    });

    test('getChangesBetween compares ancestor against multi-level stacked commits leading to @', async () => {
        const ids = await buildGraph(repo, [
            {
                label: 'base',
                files: { 'file_a.txt': 'a1\n', 'file_b.txt': 'b1\n', 'file_c.txt': 'c1\n', 'dir/file_d.txt': 'd1\n' },
            },
            { label: 'step1', parents: ['base'], files: { 'file_a.txt': 'a2\n', 'step1.txt': 'step1\n' } },
            { label: 'step2', parents: ['step1'], files: { 'dir/file_d.txt': 'd2\n' } },
            { label: 'step3', parents: ['step2'], files: { 'file with spaces in path/data.json': '{"key": "val"}\n' } },
            { label: 'step4', parents: ['step3'], files: { 'step1.txt': 'step1 modified\n', 'file_a.txt': 'a3\n' } },
            { label: 'wc', parents: ['step4'], files: { 'dir/file_d.txt': 'd3\n' } },
        ]);

        repo.edit(ids.step2.changeId);
        repo.deleteFile('file_b.txt');

        repo.edit(ids.wc.changeId);
        repo.deleteFile('file_c.txt');

        const changes = await jjService.getChangesBetween(ids.base.changeId, '@');
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            { path: 'dir/file_d.txt', status: 'modified', conflicted: false },
            { path: 'file with spaces in path/data.json', status: 'added', conflicted: false },
            { path: 'file_a.txt', status: 'modified', conflicted: false },
            { path: 'file_b.txt', status: 'deleted', conflicted: false },
            { path: 'file_c.txt', status: 'deleted', conflicted: false },
            { path: 'step1.txt', status: 'added', conflicted: false },
        ]);
    });

    test('getChangesBetween correctly detects conflict status across multi-parent merge', async () => {
        const ids = await buildGraph(repo, [
            { label: 'root', files: { 'conflict.txt': 'base content\n' } },
            { label: 'branch1', parents: ['root'], files: { 'conflict.txt': 'branch1 content\n' } },
            { label: 'branch2', parents: ['root'], files: { 'conflict.txt': 'branch2 content\n' } },
            { label: 'merge', parents: ['branch1', 'branch2'] },
        ]);

        const changes = await jjService.getChangesBetween(ids.root.changeId, ids.merge.changeId);

        expect(changes).toEqual([
            {
                path: 'conflict.txt',
                status: 'modified',
                conflicted: true,
                conflictSides: 2,
            },
        ]);
    });

    test('getChangesBetween returns empty array when comparing identical revisions', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file.txt': 'content\n' } }]);

        const changes = await jjService.getChangesBetween(ids.v1.changeId, ids.v1.changeId);

        expect(changes).toEqual([]);
    });

    test('getChangesBetween caches range results and deduplicates concurrent calls', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'a.txt': 'base\n' } },
            { label: 'child', parents: ['base'], files: { 'a.txt': 'child\n' } },
        ]);

        const [changes1, changes2] = await Promise.all([
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
            jjService.getChangesBetween(ids.base.changeId, ids.child.changeId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1).toEqual([
            {
                path: 'a.txt',
                status: 'modified',
                conflicted: false,
            },
        ]);
    });

    test('getChanges correctly identifies files with spaces in their names', async () => {
        const ids = await buildGraph(repo, [{ label: 'v1', files: { 'file with a space.txt': 'hello\n' } }]);

        const changes = await jjService.getChanges(ids.v1.changeId);

        expect(changes).toEqual([
            {
                path: 'file with a space.txt',
                status: 'added',
                conflicted: false,
                additions: 1,
                deletions: 0,
            },
        ]);
    });

    test('getChanges handles additions, modifications, deletions, and line counts accurately', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'modified.txt': 'line1\nline2\n', 'deleted.txt': 'goodbye\n' } },
            {
                label: 'child',
                parents: ['base'],
                files: {
                    'added.txt': 'new line 1\nnew line 2\n',
                    'modified.txt': 'line1\nmodified line 2\nline3\n',
                },
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.deleteFile('deleted.txt');

        const changes = await jjService.getChanges(ids.child.changeId);
        changes.sort((a, b) => a.path.localeCompare(b.path));

        expect(changes).toEqual([
            {
                path: 'added.txt',
                status: 'added',
                conflicted: false,
                additions: 2,
                deletions: 0,
            },
            {
                path: 'deleted.txt',
                status: 'deleted',
                conflicted: false,
                additions: 0,
                deletions: 1,
            },
            {
                path: 'modified.txt',
                status: 'modified',
                conflicted: false,
                additions: 2,
                deletions: 1,
            },
        ]);
    });

    test('getChanges correctly calculates additions and deletions for renamed files', async () => {
        const oldFile = 'old_name.txt';
        const newFile = 'new_name.txt';
        const baseContent = 'line1\nline2\nline3\nline4\nline5\n'.repeat(10);
        const modifiedContent = `${baseContent}line_added_1\nline_added_2\n`;

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldFile]: baseContent } },
            {
                label: 'child',
                parents: ['base'],
            },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldFile, newFile);
        repo.writeFile(newFile, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newFile);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newFile,
            status: 'renamed',
            oldPath: oldFile,
            additions: 2,
            deletions: 0,
        });
    });

    test('getChanges calculates additions and deletions for files in renamed directories', async () => {
        const oldDir = 'old_dir/nested/file.txt';
        const newDir = 'new_dir/nested/file.txt';
        const baseContent = 'line1\nline2\n';
        const modifiedContent = 'line1\nline2\nline3\n';

        const ids = await buildGraph(repo, [
            { label: 'base', files: { [oldDir]: baseContent } },
            { label: 'child', parents: ['base'] },
        ]);

        repo.edit(ids.child.changeId);
        repo.moveFile(oldDir, newDir);
        repo.writeFile(newDir, modifiedContent);

        const changes = await jjService.getChanges(ids.child.changeId);

        const renamedEntry = changes.find((c) => c.path === newDir);
        expect(renamedEntry).toBeDefined();
        expect(renamedEntry).toMatchObject({
            path: newDir,
            status: 'renamed',
            oldPath: oldDir,
            additions: 1,
            deletions: 0,
        });
    });

    test('getChanges caches results and deduplicates concurrent in-flight requests', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file1.txt': 'initial\n' } },
            { label: 'child', parents: ['base'], files: { 'file1.txt': 'updated\n', 'file2.txt': 'created\n' } },
        ]);
        const commitId = ids.child.commitId;

        // Concurrent calls (thundering herd)
        const [changes1, changes2] = await Promise.all([
            jjService.getChanges(commitId),
            jjService.getChanges(commitId),
        ]);

        expect(changes1).toEqual(changes2);
        expect(changes1.length).toBe(2);

        // Subsequent cached call
        const changes3 = await jjService.getChanges(commitId);
        expect(changes3).toEqual(changes1);
    });

    test('getChanges invalidates cache on clearCache or mutation', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'test.txt': 'v1\n' } },
            { label: 'child', parents: ['base'], files: { 'test.txt': 'v2\n' } },
        ]);

        const initialChanges = await jjService.getChanges(ids.child.changeId);
        expect(initialChanges.length).toBe(1);
        expect(initialChanges[0].path).toBe('test.txt');

        // Make mutation in child commit using repo
        repo.edit(ids.child.changeId);
        await repo.writeFiles({ 'extra.txt': 'new\n' });

        // Before clearCache / mutation, calling getChanges with cached key without clearCache would return old entries
        // Running status (which is a mutation in JjService) or explicit clearCache invalidates the cache
        await jjService.clearCache();

        const updatedChanges = await jjService.getChanges(ids.child.changeId);
        expect(updatedChanges.length).toBe(2);
        const paths = updatedChanges.map((c) => c.path).sort();
        expect(paths).toEqual(['extra.txt', 'test.txt']);
    });

    function generateRealisticCppSource(lineCount = 5500): string {
        const lines: string[] = [
            '// Copyright 2026 The Chromium Authors',
            '// Use of this source code is governed by a BSD-style license that can be',
            '// found in the LICENSE file.',
            '',
            '#include <iostream>',
            '#include <memory>',
            '#include <string>',
            '#include <vector>',
            '#include <map>',
            '',
            'namespace chrome::glic::testing {',
            '',
        ];

        let currentClass = 0;
        while (lines.length < lineCount) {
            currentClass++;
            lines.push(`class GlicApiHostHandler_${currentClass} {`);
            lines.push(' public:');
            lines.push(`  explicit GlicApiHostHandler_${currentClass}(int id) : id_(id) {}`);
            lines.push(`  virtual ~GlicApiHostHandler_${currentClass}() = default;`);
            lines.push('');
            lines.push(`  int GetHandlerId() const { return id_; }`);
            lines.push(`  std::string ComputeSignature(const std::string& input) const {`);
            lines.push(`    return "handler_" + std::to_string(id_) + "_" + input;`);
            lines.push('  }');
            lines.push('');
            lines.push(' protected:');
            lines.push(`  void HandleMessage(const std::string& type, const std::vector<uint8_t>& payload) {`);
            lines.push(`    // Processing message type: ${currentClass}`);
            lines.push('    if (type.empty()) {');
            lines.push('      return;');
            lines.push('    }');
            lines.push('    payload_cache_[type] = payload;');
            lines.push('  }');
            lines.push('');
            lines.push(' private:');
            lines.push('  int id_;');
            lines.push('  std::map<std::string, std::vector<uint8_t>> payload_cache_;');
            lines.push('};');
            lines.push('');
        }

        lines.push('} // namespace chrome::glic::testing');
        return lines.join('\n');
    }

    test('large file diff and setFilesContent', async () => {
        const originalContent = generateRealisticCppSource(5500);
        const lines = originalContent.split('\n');
        lines[1500] = '  // MODIFIED IN CHILD AT 1500: Updated signature algorithm';
        lines[3500] = '    // MODIFIED IN CHILD AT 3500: Added payload validation check';
        const modifiedContent = lines.join('\n');

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'large_file.cc': originalContent } },
            { label: 'child', parents: ['base'], files: { 'large_file.cc': modifiedContent } },
        ]);

        const diff = await jjService.getDiffContent(ids.child.commitId, 'large_file.cc');
        expect(diff.left).toBe(originalContent);
        expect(diff.right).toBe(modifiedContent);

        // Now modify and setFilesContent
        lines[2500] = '  // MODIFIED VIA SETFILESCONTENT: Injected telemetry handler';
        const newContent = lines.join('\n');
        await jjService.setFilesContent(ids.child.changeId, new Map([['large_file.cc', newContent]]));

        const saved = repo.getFileContent(ids.child.changeId, 'large_file.cc');
        expect(saved).toBe(newContent);
    });
});
