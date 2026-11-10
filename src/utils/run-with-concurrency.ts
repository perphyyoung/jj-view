/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const MAX = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 1);

/** Runs `worker` over `items` with at most `limit` tasks in flight. */
export async function runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    const queue = items.slice();
    const workerCount = Math.min(MAX(limit), queue.length);
    const running = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item === undefined) {
                return;
            }
            await worker(item);
        }
    });
    await Promise.all(running);
}
