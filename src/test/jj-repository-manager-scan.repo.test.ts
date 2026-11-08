/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { JjRepositoryManager } from '../core/jj-repository-manager';
import { Uri } from '../core/uri-utils';
import { FakeHostEnvironment } from './fake-host-environment';
import { TestRepo } from './test-repo';
import { createMockLogOutputChannel } from './test-utils';

/**
 * Auto-detection must stay one level deep: the workspace root plus its immediate children.
 * Nested working copies (test scratch dirs under `tmp/`, vendored repos) are the reason this
 * exists - registering them made scanning and every refresh dramatically slower.
 */
describe('JjRepositoryManager scan depth', () => {
    let workspaceRoot: string;
    let host: FakeHostEnvironment;
    let manager: JjRepositoryManager | undefined;
    const repos: TestRepo[] = [];
    let usedPatterns: string[] = [];

    beforeEach(() => {
        workspaceRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'scan-probe-'));
        host = new FakeHostEnvironment();
        host.workspace.addFolder(Uri.file(workspaceRoot));
        repos.length = 0;
        usedPatterns = [];
    });

    afterEach(async () => {
        await manager?.dispose();
        manager = undefined;
        for (const repo of repos) {
            await repo.dispose();
        }
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    });

    function createRepo(relativePath: string): TestRepo {
        const repo = new TestRepo(path.join(workspaceRoot, relativePath));
        repo.init();
        repos.push(repo);
        return repo;
    }

    /** Minimal glob: `*` = immediate children, `**` = recursive. */
    function installFindFiles(): void {
        host.workspace.findFiles = async (pattern: string) => {
            usedPatterns.push(pattern);
            const matches: Uri[] = [];
            const marker = '.jj/working_copy/type';

            const walk = (dir: string, depth: number) => {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const entry of entries) {
                    if (!entry.isDirectory()) {
                        continue;
                    }
                    const child = path.join(dir, entry.name);
                    if (fs.existsSync(path.join(child, marker))) {
                        matches.push(Uri.file(path.join(child, marker)));
                    }
                    // `**` descends everywhere; `*` only looks at immediate children.
                    if (pattern.startsWith('**')) {
                        walk(child, depth + 1);
                    }
                }
            };

            walk(workspaceRoot, 0);
            return matches;
        };
    }

    test('registers only the workspace root and its immediate subdirectories', async () => {
        createRepo('lvl1');
        createRepo(path.join('lvl1', 'lvl2'));
        createRepo(path.join('tmp', 'scratch-repo'));
        installFindFiles();

        manager = new JjRepositoryManager(createMockLogOutputChannel(), host);
        await manager.scanForRepositories();

        const registered = manager.repositories.map((r) => path.resolve(r.rootUri.fsPath).toLowerCase());
        const root = path.resolve(workspaceRoot).toLowerCase();
        expect(usedPatterns).toContain('*/.jj/working_copy/type');
        expect(usedPatterns).not.toContain('**/.jj/working_copy/type');

        expect(registered, `registered=${registered.join(' | ')}`).toContain(path.join(root, 'lvl1'));
        expect(registered).not.toContain(path.join(root, 'lvl1', 'lvl2'));
        expect(registered).not.toContain(path.join(root, 'tmp', 'scratch-repo'));
    });

    test('detectSubRepositories=false registers only the workspace root', async () => {
        host.config.set('detectSubRepositories', false);
        createRepo('lvl1');
        installFindFiles();

        manager = new JjRepositoryManager(createMockLogOutputChannel(), host);
        await manager.scanForRepositories();

        const registered = manager.repositories.map((r) => path.resolve(r.rootUri.fsPath).toLowerCase());
        const root = path.resolve(workspaceRoot).toLowerCase();
        expect(usedPatterns).toEqual([]);
        expect(registered).not.toContain(path.join(root, 'lvl1'));
    });

    test('legacy autoRepositoryDetection=subFolders still enables sub-repository detection', async () => {
        host.config.set('autoRepositoryDetection', 'subFolders');
        createRepo('lvl1');
        createRepo(path.join('lvl1', 'lvl2'));
        installFindFiles();

        manager = new JjRepositoryManager(createMockLogOutputChannel(), host);
        await manager.scanForRepositories();

        const registered = manager.repositories.map((r) => path.resolve(r.rootUri.fsPath).toLowerCase());
        const root = path.resolve(workspaceRoot).toLowerCase();
        expect(usedPatterns).toEqual(['*/.jj/working_copy/type']);
        expect(registered, `registered=${registered.join(' | ')}`).toContain(path.join(root, 'lvl1'));
        expect(registered).not.toContain(path.join(root, 'lvl1', 'lvl2'));
    });
});
