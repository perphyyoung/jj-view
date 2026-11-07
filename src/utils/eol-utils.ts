/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Removes a trailing carriage return from one line.
 *
 * Used before line-by-line comparisons: a commit blob is usually stored with LF while the
 * editor buffer or a `core.autocrlf` checkout uses CRLF, and comparing the raw strings makes
 * every line look modified.
 */
export function stripCarriageReturn(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Drops trailing whitespace for comparisons.
 *
 * jj's diff output can lose a bare `\r`, so a CRLF rewrite reaches the tooltip as two
 * identical strings. Callers use this to distinguish "same visible text" from "really equal".
 */
export function stripTrailingWhitespace(line: string): string {
    return line.replace(/[ \t]+$/, '');
}

/** True when two lines differ only in line endings or trailing whitespace. */
export function differsOnlyInvisibly(before: string, after: string): boolean {
    return stripTrailingWhitespace(stripCarriageReturn(before)) === stripTrailingWhitespace(after) && before !== after;
}
