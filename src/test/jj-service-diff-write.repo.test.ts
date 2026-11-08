/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as cp from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { JjService, NO_OP_LOGGER } from '../core/jj-service';
import { buildGraph, TestRepo } from './test-repo';
import { makeTestTmpDirAsync } from './test-tmp-root';

describe('JjService diff writes', () => {
    let jjService: JjService;
    let repo: TestRepo;

    beforeEach(() => {
        repo = new TestRepo();
        repo.init();
        jjService = new JjService(repo.path, NO_OP_LOGGER);
    });

    test('setFilesContent works in a subfolder workspace', async () => {
        const subDir = path.join(repo.path, 'subfolder');
        fsSync.mkdirSync(subDir, { recursive: true });

        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'subfolder/file.txt': 'initial sub' } },
            { label: 'child', parents: ['base'], files: { 'subfolder/file.txt': 'mod sub' } },
        ]);

        const subfolderJjService = new JjService(subDir, NO_OP_LOGGER);
        await subfolderJjService.setFilesContent(
            ids.child.changeId,
            new Map([['file.txt', 'updated from subfolder service']]),
        );

        const saved = repo.getFileContent(ids.child.changeId, 'subfolder/file.txt');
        expect(saved).toBe('updated from subfolder service');
    });

    test('getDiffForRevision throws and does not cache when revision is invalid or diff extraction fails', async () => {
        await expect(jjService.getDiffForRevision('non-existent-rev-12345')).rejects.toThrow();

        // Ensure invalid cache entry was not stored
        const invalidCache = await jjService.getDiffForRevision('non-existent-rev-12345').catch(() => null);
        expect(invalidCache).toBeNull();
    });

    test('setFilesContent handles file paths with potential temp slug collisions', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'a/b_c.txt': 'initial 1', 'a_b/c.txt': 'initial 2' } },
            { label: 'child', parents: ['base'], files: { 'a/b_c.txt': 'child 1', 'a_b/c.txt': 'child 2' } },
        ]);

        const filesToEdit = new Map([
            ['a/b_c.txt', 'updated a/b_c'],
            ['a_b/c.txt', 'updated a_b/c'],
        ]);

        await jjService.setFilesContent(ids.child.changeId, filesToEdit);

        expect(repo.getFileContent(ids.child.changeId, 'a/b_c.txt')).toBe('updated a/b_c');
        expect(repo.getFileContent(ids.child.changeId, 'a_b/c.txt')).toBe('updated a_b/c');
    });

    test('setFilesContent with empty map is a no-op', async () => {
        const ids = await buildGraph(repo, [{ label: 'base', files: { 'file.txt': 'hello' } }]);

        await expect(jjService.setFilesContent(ids.base.changeId, new Map())).resolves.toBeUndefined();
    });

    test('mutation automatically invalidates diff and changes cache', async () => {
        const ids = await buildGraph(repo, [
            { label: 'base', files: { 'file.txt': 'initial' } },
            { label: 'child', parents: ['base'], files: { 'file.txt': 'child v1' } },
        ]);

        // 1. Warm diff cache
        const cache1 = await jjService.getDiffForRevision(ids.child.changeId);
        const rightFile1 = path.join(cache1.tempDir, 'right', 'file.txt');
        expect(await fs.readFile(rightFile1, 'utf8')).toBe('child v1');

        // 2. Perform a mutation via setFilesContent
        await jjService.setFilesContent(ids.child.changeId, new Map([['file.txt', 'child v2']]));

        // 3. Next getDiffForRevision should return new cache with updated content
        const cache2 = await jjService.getDiffForRevision(ids.child.changeId);
        const rightFile2 = path.join(cache2.tempDir, 'right', 'file.txt');
        expect(await fs.readFile(rightFile2, 'utf8')).toBe('child v2');
    });

    test('batch-diff script does not create .complete marker when copy fails', async () => {
        const scriptPath = path.resolve(__dirname, '../../scripts/batch-diff.sh');
        if (process.platform === 'win32') {
            return; // Unix shell script test
        }

        const tempBase = await makeTestTmpDirAsync('batch-diff-test-');
        try {
            const leftDir = path.join(tempBase, 'left');
            const rightDir = path.join(tempBase, 'right');
            const outLeft = path.join(tempBase, 'outLeft');
            const outRight = path.join(tempBase, 'outRight');

            await fs.mkdir(leftDir, { recursive: true });
            await fs.mkdir(rightDir, { recursive: true });
            await fs.writeFile(path.join(rightDir, 'test.txt'), 'content');

            // Make outRight a read-only file (not directory) so mkdir/cp fails
            await fs.writeFile(outRight, 'blocker', { mode: 0o444 });

            const result = cp.spawnSync('bash', [scriptPath, leftDir, rightDir, outLeft, outRight]);
            expect(result.status).toBe(1);

            // .complete marker should NOT exist
            const completeMarker = path.join(outRight, '.complete');
            await expect(fs.access(completeMarker)).rejects.toThrow();
        } finally {
            await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
        }
    });

    test('batch-diff script successfully copies clean directory structure and writes .complete marker', async () => {
        const scriptPath = path.resolve(__dirname, '../../scripts/batch-diff.sh');
        if (process.platform === 'win32') {
            return; // Unix shell script test
        }

        const tempBase = await makeTestTmpDirAsync('batch-diff-success-');
        try {
            const leftDir = path.join(tempBase, 'left');
            const rightDir = path.join(tempBase, 'right');
            const outLeft = path.join(tempBase, 'outLeft');
            const outRight = path.join(tempBase, 'outRight');

            await fs.mkdir(path.join(leftDir, 'nested'), { recursive: true });
            await fs.mkdir(path.join(rightDir, 'nested'), { recursive: true });
            await fs.writeFile(path.join(leftDir, 'nested', 'left.txt'), 'left content');
            await fs.writeFile(path.join(rightDir, 'nested', 'right.txt'), 'right content');

            const result = cp.spawnSync('bash', [scriptPath, leftDir, rightDir, outLeft, outRight]);
            expect(result.status).toBe(1); // Exits 1 intentionally

            // .complete marker must exist
            const completeMarker = path.join(outRight, '.complete');
            await expect(fs.access(completeMarker)).resolves.toBeUndefined();

            // Content must match
            expect(await fs.readFile(path.join(outLeft, 'nested', 'left.txt'), 'utf8')).toBe('left content');
            expect(await fs.readFile(path.join(outRight, 'nested', 'right.txt'), 'utf8')).toBe('right content');

            // Must NOT have copied parent directory contents
            expect(await fs.access(path.join(outRight, 'right')).catch(() => false)).toBe(false);
            expect(await fs.access(path.join(outRight, 'left')).catch(() => false)).toBe(false);
        } finally {
            await fs.rm(tempBase, { recursive: true, force: true }).catch(() => {});
        }
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
        const originalContent = generateRealisticCppSource(2000);
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
