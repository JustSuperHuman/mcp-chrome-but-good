// Audit tracked source and, with --release, every text file shipped in the bundle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Ideographs and radicals, including supplementary planes. Shared punctuation
// such as a middle dot is also used in English and is intentionally permitted.
const chinese = /[\u2e80-\u2fff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{323af}]/u;
const decoder = new TextDecoder('utf-8', { fatal: true });
const files = new Set(
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => join(root, path)),
);
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else files.add(path);
  }
}
const release = process.argv.includes('--release');
if (release) {
  const { version } = JSON.parse(
    readFileSync(join(root, 'app/chrome-extension/package.json'), 'utf8'),
  );
  const stage = join(root, 'release/stage', `justbrowse-${version}`);
  collect(stage);
  const locales = readdirSync(join(stage, 'extension/_locales'));
  for (const locale of ['zh_CN', 'zh_TW', 'ja']) {
    assert.ok(!locales.includes(locale), `Unexpected release locale: ${locale}`);
  }
}

const violations = [];
let checkedTextFiles = 0;
let binaryFiles = 0;
for (const path of files) {
  assert.ok(statSync(path).isFile(), `Missing source file: ${relative(root, path)}`);
  if (chinese.test(relative(root, path))) violations.push(relative(root, path));
  const bytes = readFileSync(path);
  let text;
  try {
    if (bytes.includes(0)) {
      binaryFiles++;
      continue;
    }
    text = decoder.decode(bytes);
  } catch {
    binaryFiles++;
    continue;
  }
  checkedTextFiles++;
  const match = chinese.exec(text);
  if (match) {
    const line = text.slice(0, match.index).split('\n').length;
    violations.push(`${relative(root, path)}:${line}`);
  }
}
assert.deepEqual(violations, [], `Chinese text found:\n${violations.join('\n')}`);
console.log(
  JSON.stringify(
    { ok: true, release, checkedTextFiles, binaryFiles, chineseTextFiles: 0 },
    null,
    2,
  ),
);
