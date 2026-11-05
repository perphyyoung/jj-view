/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { composeOpHeadsVersion, isStaleSnapshot } from '../core/repos/op-heads-version';

describe('composeOpHeadsVersion', () => {
    it('sorts names so the version is order independent', () => {
        expect(composeOpHeadsVersion(['b', 'a'])).toBe(composeOpHeadsVersion(['a', 'b']));
    });

    it('joins names and ignores empty entries', () => {
        expect(composeOpHeadsVersion(['b', '', 'a'])).toBe('a,b');
    });

    it('returns an empty string for an empty directory', () => {
        expect(composeOpHeadsVersion([])).toBe('');
    });
});

describe('isStaleSnapshot', () => {
    it('detects a snapshot that was superseded while it was computed', () => {
        expect(isStaleSnapshot('v1', 'v2')).toBe(true);
    });

    it('keeps a snapshot computed from the current version', () => {
        expect(isStaleSnapshot('v2', 'v2')).toBe(false);
    });

    it('never discards when either version is unknown', () => {
        expect(isStaleSnapshot('', 'v2')).toBe(false);
        expect(isStaleSnapshot('v1', '')).toBe(false);
        expect(isStaleSnapshot(undefined, undefined)).toBe(false);
    });
});
