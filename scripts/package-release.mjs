#!/usr/bin/env node
// Builds a JustBrowseMCP release into release/:
//
//   justbrowse-<version>.zip and justbrowse-<version>.tar.gz, each holding justbrowse-<version>/ with
//     extension/   the Chrome MV3 extension, built with JustBrowse's key (ID dgpjcgoidnfedcpaijeelljbppcfhcll)
//     bridge/      the native bridge, installed on the user's machine with
//                  `npm install --omit=dev --install-links` (chrome-mcp-shared is vendored)
//     skills/      the justbrowse-browser agent skill
//     install.ps1, install.sh, README.md, LICENSE, release.json
//   SHA256SUMS
//
// Run from the repository root after `corepack pnpm@8.15.9 install --frozen-lockfile` (or npx pnpm@8.15.9 …):
//   node scripts/package-release.mjs            build everything, then package
//   node scripts/package-release.mjs --no-build package what is already built
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionId = 'dgpjcgoidnfedcpaijeelljbppcfhcll';
// pnpm 8 through Corepack, or npx where Node no longer ships Corepack (25+); PNPM overrides both
const hasCorepack = (() => {
  try {
    execSync('corepack --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const pnpm = process.env.PNPM || (hasCorepack ? 'corepack pnpm@8.15.9' : 'npx -y pnpm@8.15.9');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const run = (cmd, env = {}) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
};

const extensionPkg = read('app/chrome-extension/package.json');
const bridgePkg = read('app/native-server/package.json');
const sharedPkg = read('packages/shared/package.json');
const version = extensionPkg.version;

if (!process.argv.includes('--no-build')) {
  run(`${pnpm} build:shared`);
  run(`${pnpm} build:native`);
  run(`${pnpm} --filter chrome-mcp-server build`, { JUSTBROWSE_RELEASE: '1', NODE_ENV: 'production' });
}

const built = join(root, 'app/chrome-extension/.output-release/chrome-mv3');
const manifest = JSON.parse(readFileSync(join(built, 'manifest.json'), 'utf8'));
if (!manifest.key) throw new Error(`${built} has no manifest key: build it with JUSTBROWSE_RELEASE=1`);
if (manifest.version !== version) throw new Error(`built extension is ${manifest.version}, package.json says ${version}`);

const out = join(root, 'release');
const name = `justbrowse-${version}`;
const stage = join(out, 'stage', name);
rmSync(join(out, 'stage'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// the extension
cpSync(built, join(stage, 'extension'), { recursive: true });

// the bridge: its build, without logs or the build machine's node path, and a package.json npm can install
const bridge = join(stage, 'bridge');
cpSync(join(root, 'app/native-server/dist'), join(bridge, 'dist'), {
  recursive: true,
  filter: (src) => !/[\\/]dist[\\/](logs|node_path\.txt)$/.test(src) && !src.endsWith('.test.js'),
});
const { devDependencies: _d, scripts: _s, husky: _h, 'lint-staged': _l, files: _f, ...bridgeManifest } = bridgePkg;
bridgeManifest.dependencies = { ...bridgePkg.dependencies, 'chrome-mcp-shared': 'file:vendor/chrome-mcp-shared' };
writeFileSync(join(bridge, 'package.json'), JSON.stringify(bridgeManifest, null, 2) + '\n');
const shared = join(bridge, 'vendor/chrome-mcp-shared');
cpSync(join(root, 'packages/shared/dist'), join(shared, 'dist'), { recursive: true });
const { devDependencies: _sd, scripts: _ss, ...sharedManifest } = sharedPkg;
writeFileSync(join(shared, 'package.json'), JSON.stringify(sharedManifest, null, 2) + '\n');

// the agent skill, the installers and the docs
cpSync(join(root, 'skills'), join(stage, 'skills'), { recursive: true });
for (const f of ['install.ps1', 'install.sh', 'README.md', 'LICENSE']) cpSync(join(root, f), join(stage, f));
writeFileSync(
  join(stage, 'release.json'),
  JSON.stringify({ version, bridge: bridgePkg.version, extensionId, mcp: 'http://127.0.0.1:12306/mcp' }, null, 2) + '\n',
);

// the archives (bsdtar on Windows and macOS, GNU tar and zip elsewhere)
for (const f of readdirSync(out)) if (/^justbrowse-.*\.(zip|tar\.gz)$|^SHA256SUMS$/.test(f)) rmSync(join(out, f));
const zip = join(out, `${name}.zip`);
const tgz = join(out, `${name}.tar.gz`);
const staged = join(out, 'stage');
// Windows' own bsdtar, not a GNU tar from Git Bash (which reads "F:" as a remote host and can't write zips);
// paths stay relative to the stage for the same reason
const tar = process.platform === 'win32' ? `"${join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')}"` : 'tar';
if (process.platform === 'linux') {
  execSync(`zip -qr "../${name}.zip" "${name}"`, { cwd: staged, stdio: 'inherit' });
} else {
  execSync(`${tar} -a -c -f "../${name}.zip" "${name}"`, { cwd: staged, stdio: 'inherit' });
}
execSync(`${tar} -c -z -f "../${name}.tar.gz" "${name}"`, { cwd: staged, stdio: 'inherit' });

const sums = [zip, tgz]
  .map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f.split(/[\\/]/).pop()}`)
  .join('\n');
writeFileSync(join(out, 'SHA256SUMS'), sums + '\n');
console.log(`\n${sums}\n\nextension ${version} (${extensionId}) · bridge ${bridgePkg.version}`);
if (!existsSync(join(stage, 'bridge/dist/cli.js'))) throw new Error('the bridge has no dist/cli.js');
