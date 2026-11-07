/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { differsOnlyInvisibly, stripCarriageReturn, stripTrailingWhitespace } from '../utils/eol-utils';

describe('stripCarriageReturn', () => {
    it('removes one trailing CR', () => {
        expect(stripCarriageReturn('a\r')).toBe('a');
    });

    it('leaves LF-only lines untouched', () => {
        expect(stripCarriageReturn('a')).toBe('a');
    });

    it('does not touch a CR in the middle of the line', () => {
        expect(stripCarriageReturn('a\rb')).toBe('a\rb');
    });
});

describe('stripTrailingWhitespace', () => {
    it('drops trailing spaces and tabs', () => {
        expect(stripTrailingWhitespace('a \t')).toBe('a');
    });

    it('keeps inner whitespace', () => {
        expect(stripTrailingWhitespace('a b')).toBe('a b');
    });
});

describe('differsOnlyInvisibly', () => {
    it('is true for a CRLF/LF pair', () => {
        expect(differsOnlyInvisibly('a\r', 'a')).toBe(true);
    });

    it('is true for trailing spaces', () => {
        expect(differsOnlyInvisibly('a  ', 'a')).toBe(true);
    });

    it('is false when the text differs', () => {
        expect(differsOnlyInvisibly('a', 'b')).toBe(false);
    });

    it('is false for identical lines', () => {
        expect(differsOnlyInvisibly('a', 'a')).toBe(false);
    });
});
