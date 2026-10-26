// Regression check for quoted PATH entries breaking cmd parsing or native stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

if (process.platform !== 'win32') {
  console.log('Windows launcher check skipped on this platform.');
  process.exit(0);
}

const fixture = mkdtempSync(join(tmpdir(), 'justbrowse-launcher-'));
try {
  const launcher = join(fixture, 'run_host.bat');
  copyFileSync(new URL('../app/native-server/src/scripts/run_host.bat', import.meta.url), launcher);
  writeFileSync(join(fixture, 'node_path.txt'), process.execPath);
  writeFileSync(join(fixture, 'index.js'), `
    const body = Buffer.from(JSON.stringify({ type: 'launcher_test', ok: true }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([header, body]));
  `);
  const baseEnv = { ...process.env };
  const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === 'path');
  const inheritedPath = baseEnv[pathKey] || '';
  delete baseEnv[pathKey];
  for (const entry of ['', '"C:\\Program Files (x86)\\BrowserStackLocal\\";', 'C:\\Tools & Utilities;']) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', launcher], {
      env: {
        ...baseEnv,
        Path: entry + inheritedPath,
        LOCALAPPDATA: fixture,
        CHROME_MCP_NODE_PATH: '',
        ANTHROPIC_BASE_URL: '',
        ANTHROPIC_AUTH_TOKEN: 'launcher-test-placeholder',
      },
      input: Buffer.alloc(0),
      windowsHide: true,
      timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.equal(result.stderr.length, 0, 'Launcher emitted an error');
    assert.equal(result.stdout.length, result.stdout.readUInt32LE(0) + 4, 'Native stdout was corrupted');
    assert.deepEqual(JSON.parse(result.stdout.subarray(4)), { type: 'launcher_test', ok: true });
  }
  const source = readFileSync(launcher, 'utf8');
  const installed = readFileSync(new URL('../app/native-server/dist/run_host.bat', import.meta.url), 'utf8');
  assert.equal(installed, source, 'Built launcher differs from source; rebuild or copy it before testing');
  console.log('Windows launcher passed: inherited PATH, quoted parentheses, ampersand, clean native framing.');
} finally {
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()), 'Cleanup must stay inside OS temp');
  assert.ok(fixture.startsWith(join(tmpdir(), 'justbrowse-launcher-')));
  rmSync(fixture, { recursive: true, force: true });
}
