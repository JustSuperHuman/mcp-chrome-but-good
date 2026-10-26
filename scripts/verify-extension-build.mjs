import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = resolve(root, 'app/chrome-extension');
// JUSTBROWSE_RELEASE=1 checks the release build (scripts/package-release.mjs) instead of the development one
const release = process.env.JUSTBROWSE_RELEASE === '1';
const output = resolve(extension, release ? '.output-release/chrome-mv3' : '.output/chrome-mv3');
const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(extension, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.default_locale, 'en');
if (release) assert.ok(manifest.key, 'a release build carries the JustBrowse key (a stable extension ID)');
const locales = await readdir(resolve(output, '_locales'));
for (const locale of ['zh_CN', 'zh_TW', 'ja']) assert.ok(!locales.includes(locale), `Unexpected locale: ${locale}`);
assert.ok(!manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"));
assert.ok(!manifest.content_security_policy.extension_pages.includes('localhost'));
for (const permission of ['nativeMessaging', 'tabs', 'tabGroups', 'debugger', 'storage']) {
  assert.ok(manifest.permissions.includes(permission), `Missing permission: ${permission}`);
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesIn(path) : [path];
    }),
  );
  return nested.flat();
}

let checkedAssets = 0;
for (const directory of ['inject-scripts', 'workers', '_locales']) {
  for (const source of await filesIn(resolve(extension, directory))) {
    const target = resolve(output, relative(extension, source));
    assert.deepEqual(
      await readFile(target),
      await readFile(source),
      `Stale/missing asset: ${target}`,
    );
    checkedAssets++;
  }
}

const referenced = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
]);
for (const html of (await filesIn(output)).filter((path) => path.endsWith('.html'))) {
  const content = await readFile(html, 'utf8');
  for (const [, reference] of content.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue;
    const path = reference.startsWith('/')
      ? resolve(output, reference.slice(1))
      : resolve(dirname(html), reference);
    referenced.add(relative(output, path));
  }
}
for (const reference of referenced) {
  const path = resolve(output, reference.replace(/^\//, ''));
  assert.ok(path.startsWith(`${output}${sep}`), `Asset escapes extension: ${reference}`);
  assert.ok((await stat(path)).size > 0, `Missing/empty entrypoint: ${reference}`);
}
const locale = JSON.parse(
  await readFile(resolve(output, '_locales', manifest.default_locale, 'messages.json'), 'utf8'),
);
for (const key of ['name', 'description']) {
  const message = /^__MSG_(.+)__$/.exec(manifest[key]);
  if (message) assert.ok(locale[message[1]]?.message, `Missing localized ${key}`);
}
const archive = release
  ? resolve(root, 'release', `justbrowse-${pkg.version}.zip`)
  : resolve(extension, '.output', `${pkg.name}-${pkg.version}-chrome.zip`);
const archiveBytes = await readFile(archive);
console.log(
  JSON.stringify(
    {
      ok: true,
      extensionVersion: manifest.version,
      checkedStaticAssets: checkedAssets,
      checkedEntrypoints: referenced.size,
      unpackedPath: output,
      archive,
      archiveBytes: archiveBytes.length,
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    },
    null,
    2,
  ),
);
