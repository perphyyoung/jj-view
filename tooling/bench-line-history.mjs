/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compares the two ways to collect a line's committed history.
 *
 * Usage: node tooling/bench-line-history.mjs <repo> <file> <line>
 *
 * - git: one `git log -L <line>,<line>:<file> --no-patch` call.
 * - jj: one `jj diff` per commit, following the line through each patch (the naive
 *   implementation that `git log -L` replaces).
 *
 * Not part of CI: timings depend on the machine; the numbers are for design decisions.
 */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const [repo = '.', file = 'package.json', lineArg = '1'] = process.argv.slice(2);
const line = Number(lineArg);
if (!Number.isInteger(line) || line < 1) {
    console.error('line must be a positive integer');
    process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', maxBuffer: 5e8 });

function gitLineHistory(withPatch) {
    const args = ['log', '-L', `${line},${line}:${file}`, '--format=%H', '-n', '200'];
    if (!withPatch) {
        args.push('--no-patch');
    }
    args.push('HEAD');
    const start = performance.now();
    const out = run('git', args);
    return {
        ms: Math.round(performance.now() - start),
        commits: out.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l.trim())).length,
        bytes: out.length,
    };
}

function findLineChange(diffText, target) {
    let oldNo = 0;
    let newNo = 0;
    let pending = [];
    for (const raw of diffText.split('\n')) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) {
            oldNo = Number(hunk[1]);
            newNo = Number(hunk[2]);
            pending = [];
            continue;
        }
        if (oldNo === 0 || raw.startsWith('diff ') || raw.startsWith('---') || raw.startsWith('+++')) {
            continue;
        }
        const c = raw[0];
        if (c === ' ') {
            oldNo++;
            newNo++;
            pending = [];
        } else if (c === '-') {
            pending.push(oldNo);
            oldNo++;
        } else if (c === '+') {
            if (newNo === target) {
                return { changed: true, parentLine: pending[0] };
            }
            newNo++;
        }
    }
    return { changed: false };
}

function jjPerCommitHistory() {
    const start = performance.now();
    let rev = '@-';
    let currentLine = line;
    let steps = 0;
    let hits = 0;
    while (steps < 200) {
        steps++;
        const diff = run('jj', ['diff', '--git', '-r', rev, '--', file]);
        const change = diff.trim() === '' ? { changed: false } : findLineChange(diff, currentLine);
        if (change.changed) {
            hits++;
            if (change.parentLine === undefined) {
                break;
            }
            currentLine = change.parentLine;
        }
        const parents = run('jj', ['log', '-r', `parents(${rev})`, '--no-graph', '-T', 'commit_id ++ "\\n"'])
            .trim()
            .split('\n')
            .filter(Boolean);
        if (parents.length === 0) {
            break;
        }
        rev = parents[0];
    }
    return { ms: Math.round(performance.now() - start), steps, hits };
}

// The command needs the patches (they carry the line text), so compare both git variants.
const git = gitLineHistory(true);
const gitMetadataOnly = gitLineHistory(false);
const jj = jjPerCommitHistory();
console.log(JSON.stringify({ repo, file, line, git, gitMetadataOnly, jj }, null, 2));
