/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Enforces the "local-first" promise: jj-view must not contact a remote on its own.
 *
 * The only user-initiated paths that may run remote git commands are the upload
 * commands (`jj git push`), and `extension.ts` which passively *detects* uploads
 * typed into a terminal. Everything else must stay local.
 */

const scannedDirs = ['src/core', 'src/vscode'];

const allowedFiles = new Set([
    path.join('src', 'core', 'commands', 'upload.ts'),
    path.join('src', 'core', 'commands', 'upload-stack.ts'),
    path.join('src', 'vscode', 'extension.ts'),
]);

const patterns: Array<{ re: RegExp; reason: string }> = [
    {
        re: /\bgitFetch\b|\bgitPush\b|\bgitClone\b/,
        reason: 'Remote git helper; only user-initiated uploads may contact remotes.',
    },
    {
        re: /['"]git['"]\s*,\s*['"](push|fetch|clone)['"]/,
        reason: "Arguments for 'git push/fetch/clone'.",
    },
    {
        re: /['"]git\s+(push|fetch|clone)/,
        reason: 'Remote git command string.',
    },
];

/** Passive terminal-command detection (`cmd.includes('git push')`) is allowed. */
const detectionPattern = /\.includes\(\s*['"]git\s+(push|fetch|clone)/;

function walk(dirPath: string): string[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...walk(fullPath));
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte'))) {
            files.push(fullPath);
        }
    }

    return files;
}

const violations: Array<{ file: string; line: number; content: string; reason: string }> = [];
let scannedCount = 0;

for (const dir of scannedDirs) {
    for (const filePath of walk(path.resolve(process.cwd(), dir))) {
        const relative = path.relative(process.cwd(), filePath);
        if (allowedFiles.has(relative)) {
            continue;
        }

        scannedCount++;
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
                return;
            }
            if (detectionPattern.test(line)) {
                return;
            }

            for (const { re, reason } of patterns) {
                if (re.test(line)) {
                    violations.push({ file: relative, line: index + 1, content: trimmed, reason });
                }
            }
        });
    }
}

if (violations.length > 0) {
    console.error('\n[LINT ERROR] Remote git command found outside the upload flow:');
    for (const violation of violations) {
        console.error(`  ${violation.file}:${violation.line} -> ${violation.content} (${violation.reason})`);
    }
    console.error('\njj-view is local-first: only explicit upload commands may contact a remote.\n');
    process.exit(1);
}

console.log(`Local-only lint passed: ${scannedCount} files in src/core + src/vscode never run remote git commands.`);
process.exit(0);
