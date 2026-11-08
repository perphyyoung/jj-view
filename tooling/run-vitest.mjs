/**
 * Runs Vitest with a wall-clock limit.
 *
 * The repo tier already has per-test timeouts, but a suite can still drag on for many
 * minutes. This wrapper stops the run at the deadline, kills the process tree (jj children
 * included) and reports that the suite was cut short, so a slow suite fails fast instead of
 * hanging. The files that did not finish are the ones missing a result in the verbose log.
 *
 * Usage: node tooling/run-vitest.mjs --timeout <ms> [vitest args...]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const timeoutIndex = args.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 0;
const vitestArgs = timeoutIndex >= 0 ? [...args.slice(0, timeoutIndex), ...args.slice(timeoutIndex + 2)] : args;

// `--perf` opts into the subprocess summary (the repo tier always wants it, the unit tier
// only when explicitly requested).
const perfIndex = vitestArgs.indexOf('--perf');
if (perfIndex >= 0) {
    vitestArgs.splice(perfIndex, 1);
    process.env.JJ_VIEW_PERF = '1';
}

const vitestBin = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestBin)) {
    console.error(`vitest binary not found: ${vitestBin}`);
    process.exit(1);
}

const child = spawn(process.execPath, [vitestBin, ...vitestArgs], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
});

function killTree(target) {
    if (target.pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        // Kill the whole tree: the jj processes spawned by the tests must go as well.
        spawn('taskkill', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        try {
            process.kill(-target.pid, 'SIGKILL');
        } catch {
            target.kill('SIGKILL');
        }
    }
}

let timedOut = false;
const timer =
    timeoutMs > 0
        ? setTimeout(() => {
              timedOut = true;
              console.error(`\n[TIMEOUT] suite exceeded ${timeoutMs}ms, stopping the run.`);
              killTree(child);
          }, timeoutMs)
        : undefined;

child.on('exit', (code, signal) => {
    if (timer) {
        clearTimeout(timer);
    }
    if (timedOut) {
        console.error('[TIMEOUT] The files without a result in the verbose output did not finish.');
        console.error('[TIMEOUT] Optimize them (fewer jj invocations, shared templates) instead of waiting.');
        process.exit(1);
    }
    process.exit(code ?? (signal ? 1 : 0));
});
