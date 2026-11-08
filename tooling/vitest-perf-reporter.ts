/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Reporter, TestModule } from 'vitest/reporters';

interface TraceRecord {
    caller: 'TestRepo' | 'JjService';
    command: string;
    durationMs: number;
    testFile?: string;
}

interface CommandStat {
    command: string;
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
}

export class VitestPerfReporter implements Reporter {
    private traceFilePath: string;
    /** Wall-clock start, so the last line of every run reports the total duration. */
    private readonly startedAt = Date.now();

    constructor(traceFilePath?: string) {
        if (traceFilePath) {
            this.traceFilePath = traceFilePath;
        } else {
            const existing = process.env.JJ_VIEW_PERF_TRACE_FILE;
            // Keep the trace inside the project tmp/ so no test writes outside the repo.
            this.traceFilePath = existing || path.join(process.cwd(), 'tmp', `jj-view-perf-trace-${process.pid}.jsonl`);
        }
        process.env.JJ_VIEW_PERF_TRACE_FILE = this.traceFilePath;

        try {
            if (fs.existsSync(this.traceFilePath)) {
                fs.unlinkSync(this.traceFilePath);
            }
        } catch {}
    }

    onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
        this.printReport(testModules);
    }

    private printReport(testModules: ReadonlyArray<TestModule>): void {
        const fileTimings: Array<{ file: string; durationMs: number; testCount: number }> = [];
        const testTimings: Array<{ name: string; file: string; durationMs: number }> = [];

        for (const mod of testModules) {
            const diag = mod.diagnostic();
            const durationMs = diag ? diag.duration : 0;
            const tests = Array.from(mod.children.allTests());

            fileTimings.push({
                file: mod.relativeModuleId,
                durationMs,
                testCount: tests.length,
            });

            for (const test of tests) {
                const testDiag = test.diagnostic();
                const testDuration = testDiag ? testDiag.duration : 0;
                testTimings.push({
                    name: test.fullName,
                    file: mod.relativeModuleId,
                    durationMs: testDuration,
                });
            }
        }

        fileTimings.sort((a, b) => b.durationMs - a.durationMs);
        testTimings.sort((a, b) => b.durationMs - a.durationMs);

        const traceRecords = this.readTraceRecords();
        const commandStats = this.aggregateCommandStats(traceRecords);

        console.log(`\n${'='.repeat(80)}`);
        console.log('                 JJ-VIEW PERFORMANCE TRACE SUMMARY');
        console.log('='.repeat(80));

        this.printSubprocessSummary(traceRecords, commandStats);
        this.printThresholds(fileTimings, traceRecords);
        this.printSlowestFiles(fileTimings.slice(0, 15));
        this.printSlowestTests(testTimings.slice(0, 20));

        console.log(`${'='.repeat(80)}`);

        // Always the last lines: a run whose per-test output scrolled away (or was cut short by
        // the suite timeout) still ends with counts, the wall clock and the failing test names.
        // Format mirrors vitest's own summary lines (Test Files / Tests) with color.
        const summary = this.summarize(testModules);
        const green = (s: string) => `\u001b[32m${s}\u001b[39m`;
        const red = (s: string) => `\u001b[31m${s}\u001b[39m`;
        const dim = (s: string) => `\u001b[90m${s}\u001b[39m`;
        const bold = (s: string) => `\u001b[1m${s}\u001b[22m`;

        const filesTotal = summary.filesPassed + summary.filesFailed + summary.filesSkipped;
        const testsTotal = summary.testsPassed + summary.testsFailed + summary.testsSkipped;

        const filesParts: string[] = [];
        if (summary.filesFailed > 0) {
            filesParts.push(red(`${summary.filesFailed} failed`));
        }
        if (summary.filesPassed > 0) {
            filesParts.push(green(`${summary.filesPassed} passed`));
        }
        if (summary.filesSkipped > 0) {
            filesParts.push(dim(`${summary.filesSkipped} skipped`));
        }
        console.log(` ${bold('Test Files')} ${filesParts.join(dim(' | '))} ${dim(`(${filesTotal})`)}`);

        const testsParts: string[] = [];
        if (summary.testsFailed > 0) {
            testsParts.push(red(`${summary.testsFailed} failed`));
        }
        if (summary.testsPassed > 0) {
            testsParts.push(green(`${summary.testsPassed} passed`));
        }
        if (summary.testsSkipped > 0) {
            testsParts.push(dim(`${summary.testsSkipped} skipped`));
        }
        console.log(`      ${bold('Tests')} ${testsParts.join(dim(' | '))} ${dim(`(${testsTotal})`)}`);

        if (summary.failures.length > 0) {
            console.log(red(`[PERF] failed tests (${summary.failures.length}):`));
            for (const failure of summary.failures) {
                console.log(
                    `  ${red('×')} ${failure.file} > ${failure.name}${failure.message ? ` — ${failure.message}` : ''}`,
                );
            }
        }
        const elapsedSeconds = (Date.now() - this.startedAt) / 1000;
        console.log(dim(`[PERF] wall-clock: ${elapsedSeconds.toFixed(1)}s\n`));

        try {
            if (fs.existsSync(this.traceFilePath)) {
                fs.unlinkSync(this.traceFilePath);
            }
        } catch {}
    }

    /**
     * Counts passed/failed/skipped tests and collects the failing test names with the first line
     * of their error, so the tail of the log is enough to see what broke.
     */
    private summarize(testModules: ReadonlyArray<TestModule>): {
        filesPassed: number;
        filesFailed: number;
        filesSkipped: number;
        testsPassed: number;
        testsFailed: number;
        testsSkipped: number;
        failures: Array<{ file: string; name: string; message: string }>;
    } {
        type TaskResult = { state?: string; errors?: Array<{ message?: string }> };
        const taskState = (task: unknown): string => {
            const result = (task as { result?: () => TaskResult }).result?.();
            return result?.state ?? 'passed';
        };
        const taskError = (task: unknown): string => {
            const errors = (task as { result?: () => TaskResult }).result?.()?.errors ?? [];
            const message = errors[0]?.message ?? '';
            return message.split('\n')[0]?.trim() ?? '';
        };

        const summary = {
            filesPassed: 0,
            filesFailed: 0,
            filesSkipped: 0,
            testsPassed: 0,
            testsFailed: 0,
            testsSkipped: 0,
            failures: [] as Array<{ file: string; name: string; message: string }>,
        };

        for (const mod of testModules) {
            const modState = taskState(mod);
            // Suite-level errors (e.g. mock factory failures) live in `errors`, not in
            // `result().state`, so check both to avoid under-reporting failed files.
            const modErrors = (mod as { errors?: Array<{ message?: string }> }).errors ?? [];
            const hasSuiteError = modErrors.length > 0;

            // A file is "failed" if the module itself failed OR any of its tests failed.
            const tests = [...mod.children.allTests()];
            const hasFailedTest = tests.some((t) => taskState(t) === 'failed');

            if (modState === 'failed' || hasSuiteError || hasFailedTest) {
                summary.filesFailed += 1;
                if (hasSuiteError) {
                    summary.failures.push({
                        file: mod.relativeModuleId,
                        name: '(suite)',
                        message: (modErrors[0]?.message ?? '').split('\n')[0]?.trim() ?? '',
                    });
                }
            } else if (modState === 'skipped' || modState === 'pending' || modState === 'todo') {
                summary.filesSkipped += 1;
            } else {
                summary.filesPassed += 1;
            }

            for (const test of tests) {
                const state = taskState(test);
                if (state === 'failed') {
                    summary.testsFailed += 1;
                    summary.failures.push({
                        file: mod.relativeModuleId,
                        name: test.fullName,
                        message: taskError(test),
                    });
                } else if (state === 'skipped' || state === 'pending' || state === 'todo') {
                    summary.testsSkipped += 1;
                } else {
                    summary.testsPassed += 1;
                }
            }
        }

        return summary;
    }

    private readTraceRecords(): TraceRecord[] {
        if (!fs.existsSync(this.traceFilePath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(this.traceFilePath, 'utf-8');
            const lines = content.split('\n');
            const records: TraceRecord[] = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(trimmed) as TraceRecord;
                    records.push(parsed);
                } catch {}
            }

            return records;
        } catch {
            return [];
        }
    }

    private aggregateCommandStats(records: TraceRecord[]): CommandStat[] {
        const statsMap = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();

        for (const record of records) {
            const durationMs = Math.max(0, record.durationMs);
            const existing = statsMap.get(record.command);
            if (existing) {
                existing.count += 1;
                existing.totalMs += durationMs;
                if (durationMs < existing.minMs) {
                    existing.minMs = durationMs;
                }
                if (durationMs > existing.maxMs) {
                    existing.maxMs = durationMs;
                }
            } else {
                statsMap.set(record.command, {
                    count: 1,
                    totalMs: durationMs,
                    minMs: durationMs,
                    maxMs: durationMs,
                });
            }
        }

        const result: CommandStat[] = [];
        for (const [command, stat] of statsMap.entries()) {
            result.push({
                command,
                count: stat.count,
                totalMs: stat.totalMs,
                minMs: stat.minMs,
                maxMs: stat.maxMs,
            });
        }

        result.sort((a, b) => b.totalMs - a.totalMs);
        return result;
    }

    private printSubprocessSummary(records: TraceRecord[], commandStats: CommandStat[]): void {
        const totalCalls = records.length;
        if (totalCalls === 0) {
            console.log('\n[CLI Subprocesses] No subprocess executions recorded.');
            return;
        }

        let totalDurationMs = 0;
        let testRepoCalls = 0;
        let testRepoDurationMs = 0;
        let jjServiceCalls = 0;
        let jjServiceDurationMs = 0;
        let asyncGcCalls = 0;
        let asyncGcDurationMs = 0;

        for (const r of records) {
            const durationMs = Math.max(0, r.durationMs);
            if (r.command === 'repo-config-gc') {
                asyncGcCalls += 1;
                asyncGcDurationMs += durationMs;
                continue;
            }
            totalDurationMs += durationMs;
            if (r.caller === 'TestRepo') {
                testRepoCalls += 1;
                testRepoDurationMs += durationMs;
            } else {
                jjServiceCalls += 1;
                jjServiceDurationMs += durationMs;
            }
        }

        console.log('\n--- CLI Subprocess Overhead ---');
        console.log(`Total Invocations:     ${(totalCalls - asyncGcCalls).toLocaleString()}`);
        console.log(
            `  - TestRepo:          ${testRepoCalls.toLocaleString()} (${(testRepoDurationMs / 1000).toFixed(2)}s)`,
        );
        console.log(
            `  - JjService:         ${jjServiceCalls.toLocaleString()} (${(jjServiceDurationMs / 1000).toFixed(2)}s)`,
        );
        console.log(`Total CLI CPU/Wait:    ${(totalDurationMs / 1000).toFixed(2)}s`);
        if (asyncGcCalls > 0) {
            console.log(
                `  - Async Repo GC:     ${asyncGcCalls.toLocaleString()} calls (${(asyncGcDurationMs / 1000).toFixed(2)}s non-blocking background)`,
            );
        }

        console.log('\nCommand Breakdown (ranked by total time spent):');
        console.log('-'.repeat(80));
        console.log(
            'Command'.padEnd(20) +
                '| ' +
                'Calls'.padStart(6) +
                ' | ' +
                'Total Time'.padStart(11) +
                ' | ' +
                '% Time'.padStart(7) +
                ' | ' +
                'Avg (ms)'.padStart(9) +
                ' | ' +
                'Min/Max (ms)'.padStart(14),
        );
        console.log('-'.repeat(80));

        for (const stat of commandStats) {
            const isAsync = stat.command === 'repo-config-gc';
            const pct = isAsync
                ? ' async'
                : totalDurationMs > 0
                  ? `${((stat.totalMs / totalDurationMs) * 100).toFixed(1)}%`
                  : '0.0%';
            const avg = (stat.totalMs / stat.count).toFixed(1);
            const minMax = `${Math.round(stat.minMs)} / ${Math.round(stat.maxMs)}`;
            const timeStr =
                stat.totalMs >= 1000 ? `${(stat.totalMs / 1000).toFixed(2)}s` : `${Math.round(stat.totalMs)}ms`;

            console.log(
                stat.command.slice(0, 19).padEnd(20) +
                    '| ' +
                    stat.count.toString().padStart(6) +
                    ' | ' +
                    timeStr.padStart(11) +
                    ' | ' +
                    pct.padStart(7) +
                    ' | ' +
                    avg.padStart(9) +
                    ' | ' +
                    minMax.padStart(14),
            );
        }
        console.log('-'.repeat(80));

        // Top 10 slowest individual commands
        const sortedRecords = [...records].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
        console.log('\nTop 10 Slowest Individual CLI Invocations:');
        sortedRecords.forEach((r, idx) => {
            const loc = r.testFile ? ` (${r.testFile})` : '';
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${Math.round(r.durationMs)}ms - jj ${r.command} [${r.caller}]${loc}`,
            );
        });
    }

    /**
     * Warns about files that are too slow or spawn too many jj processes.
     *
     * These are the two ways the repo tier loses time: a file that runs long, and a file whose
     * cases each start many jj processes. Both should be optimized instead of tolerated.
     */
    private printThresholds(
        files: Array<{ file: string; durationMs: number; testCount: number }>,
        records: TraceRecord[],
    ): void {
        const FILE_DURATION_LIMIT_MS = 30_000;
        const SPAWNS_PER_TEST_LIMIT = 5;

        const spawnsPerFile = new Map<string, number>();
        for (const record of records) {
            if (!record.testFile) {
                continue;
            }
            spawnsPerFile.set(record.testFile, (spawnsPerFile.get(record.testFile) ?? 0) + 1);
        }

        const warnings: string[] = [];
        for (const file of files) {
            if (file.durationMs > FILE_DURATION_LIMIT_MS) {
                warnings.push(
                    `[PERF] slow file: ${file.file} took ${(file.durationMs / 1000).toFixed(1)}s (limit ${FILE_DURATION_LIMIT_MS / 1000}s)`,
                );
            }
            const spawns = spawnsPerFile.get(file.file) ?? 0;
            const perTest = file.testCount > 0 ? spawns / file.testCount : 0;
            if (perTest > SPAWNS_PER_TEST_LIMIT) {
                warnings.push(
                    `[PERF] spawn-heavy file: ${file.file} ran ${spawns} jj commands for ${file.testCount} tests (${perTest.toFixed(1)} per test, limit ${SPAWNS_PER_TEST_LIMIT})`,
                );
            }
        }

        if (warnings.length === 0) {
            return;
        }
        console.log('\n--- Threshold Warnings ---');
        for (const warning of warnings) {
            console.log(warning);
        }
    }

    private printSlowestFiles(files: Array<{ file: string; durationMs: number; testCount: number }>): void {
        console.log('\n--- Top 15 Slowest Test Files ---');
        files.forEach((f, idx) => {
            const durationStr = `${(f.durationMs / 1000).toFixed(2)}s`;
            const countStr = `(${f.testCount} test${f.testCount === 1 ? '' : 's'})`;
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${f.file.padEnd(50)} ${durationStr.padStart(7)} ${countStr}`,
            );
        });
    }

    private printSlowestTests(tests: Array<{ name: string; file: string; durationMs: number }>): void {
        console.log('\n--- Top 20 Slowest Individual Tests ---');
        tests.forEach((t, idx) => {
            const durationStr = `${Math.round(t.durationMs)}ms`;
            const name = t.name.length > 55 ? `${t.name.slice(0, 52)}...` : t.name;
            console.log(
                `  ${(idx + 1).toString().padStart(2)}. ${durationStr.padStart(7)} - ${name.padEnd(55)} (${t.file})`,
            );
        });
    }
}
