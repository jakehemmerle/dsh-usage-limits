// Traceability gate (usage-s7): every acceptance property in SPEC.md must appear in TESTING.md's
// traceability table, and no required suite may silently skip. Fails npm test (and the Nix sandbox
// fast check) when a property loses its test or someone adds a skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(join(here, '../SPEC.md'), 'utf8');
const testing = readFileSync(join(here, '../TESTING.md'), 'utf8');

const tableStart = testing.indexOf('## Traceability');
const tableEnd = testing.indexOf('\n## ', tableStart + 4);
const table = testing.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);

const ids = [...new Set([...spec.matchAll(/^\| (U\d+) \|/gm)].map((m) => m[1]))];

test('every SPEC acceptance property appears in the TESTING.md traceability table', () => {
  assert.ok(ids.length >= 13, 'SPEC.md should declare at least U1..U13');
  for (const id of ids) {
    assert.ok(table.includes('| ' + id + ' '), 'TESTING.md traceability table is missing ' + id);
  }
});

test('traceability rows reference real test files', () => {
  for (const line of table.split('\n')) {
    if (!line.startsWith('| U')) continue;
    const files = [...line.matchAll(/(test\/[\w./-]+\.test\.js|test\/e2e\/[\w./-]+\.test\.js)/g)];
    assert.ok(files.length > 0, 'row without a test file: ' + line.slice(0, 60));
  }
});

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.host' || name === 'upstream') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

test('no required suite silently skips or is a todo', () => {
test('every test-file citation in TESTING.md exists (usage-b3)', () => {
  const cited = [...testing.matchAll(/(test\/[\w./-]+\.test\.js)/g)].map((m) => m[1]);
  const bad = cited.filter((c) => !existsSync(join(here, '..', c)));
  assert.deepEqual(bad, [], 'TESTING.md cites files that do not exist: ' + bad.join(', '));
});

function sources(dir) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/\.skip\(/.test(text), file + ' contains a skip');
    assert.ok(!/\.todo\(/.test(text), file + ' contains a todo');
  }
});
