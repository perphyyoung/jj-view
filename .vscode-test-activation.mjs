import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Same pinned host as `.vscode-test.mjs`; keep both reading the shared JSON.
const vscodeVersion =
    process.env.JVL_VSCODE_VERSION?.trim() ||
    JSON.parse(fs.readFileSync(new URL('./tooling/vscode-version.json', import.meta.url), 'utf8')).version;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-view-test-activation-user-data-'));
const userDir = path.join(tmpDir, 'User');
const workspaceDir = path.join(tmpDir, 'workspace');
fs.mkdirSync(userDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

// Write settings to disable git
fs.writeFileSync(
    path.join(userDir, 'settings.json'),
    JSON.stringify(
        {
            'git.enabled': false,
            'git.path': null,
            'git.autoRepositoryDetection': false,
        },
        null,
        4,
    ),
);

export default defineConfig({
    version: vscodeVersion,
    files: 'out/test/extension.integration.test.js',
    mocha: {
        timeout: 20000,
        require: ['./out/test/global-teardown.js'],
    },
    launchArgs: [
        '--disable-extensions',
        '--disable-extension',
        'vscode.git',
        '--user-data-dir',
        tmpDir,
        workspaceDir, // Use dedicated workspace directory
    ],
});
