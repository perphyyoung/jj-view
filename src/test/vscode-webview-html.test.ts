/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';
import { safeJsonStringify } from '../vscode/vscode-webview-html';

describe('safeJsonStringify', () => {
    test('escapes HTML special characters, slashes, ampersands, and unicode line separators', () => {
        const payload = {
            message: '</script><script>alert("XSS & danger")</script>',
            url: 'https://example.com/foo/bar',
            ampersand: 'A & B',
            lineSeparators: 'line1\u2028line2\u2029line3',
        };

        const json = safeJsonStringify(payload);
        expect(json).not.toContain('<');
        expect(json).not.toContain('>');
        expect(json).not.toContain('</script>');
        expect(json).toContain('\\u003c');
        expect(json).toContain('\\u003e');
        expect(json).toContain('\\u002f');
        expect(json).toContain('\\u0026');
        expect(json).toContain('\\u2028');
        expect(json).toContain('\\u2029');
    });
});
