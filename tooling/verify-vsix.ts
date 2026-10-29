/**
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import AdmZip from 'adm-zip';

const vsixPath = process.argv[2];
if (!vsixPath) {
    console.error('Usage: node tooling/verify-vsix.ts <vsix-path>');
    process.exit(1);
}

if (!fs.existsSync(vsixPath)) {
    console.error(`Error: File not found: ${vsixPath}`);
    process.exit(1);
}

const zip = new AdmZip(vsixPath);
const entries = zip.getEntries().map((e: AdmZip.IZipEntry) => e.entryName);

// Only the host platform is packaged (win32-x64 build), so exactly one
// platform-specific native binary is expected.
// (Filenames in VSIX are prefixed with 'extension/')
const platformPackage = `@parcel/watcher-${process.platform}-${process.arch}`;
const scriptExt = process.platform === 'win32' ? 'bat' : 'sh';
const requiredEntries = [
    `extension/dist/node_modules/${platformPackage}/watcher.node`,
    // Runtime helper scripts
    `extension/scripts/batch-diff.${scriptExt}`,
    `extension/scripts/batch-edit.${scriptExt}`,
    `extension/scripts/conflict-capture.${scriptExt}`,
];

let missing = 0;
for (const entry of requiredEntries) {
    if (!entries.includes(entry)) {
        console.error(`Missing required entry: ${entry}`);
        missing++;
    } else {
        console.log(`Verified: ${entry}`);
    }
}

if (missing > 0) {
    console.error(`\nFAILED: Found ${missing} missing essential native binaries.`);
    process.exit(1);
}

console.log('\nVSIX verification successful.');
process.exit(0);
