// The vendored rig is the nix-config skill's rig plus exactly the recorded local patch (test/rig/SOURCE.md),
// and no test imports a rig from outside the repo (~/.agents broke nix-config CI once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rig = join(here, 'rig');

test('rig provenance: mock-llm.mjs is the upstream copy byte for byte', () => {
  assert.equal(readFileSync(join(rig, 'mock-llm.mjs'), 'utf8'), readFileSync(join(rig, 'upstream', 'mock-llm.mjs'), 'utf8'));
});

test('rig provenance: rig.mjs = upstream/rig.mjs + rig.local.patch', () => {
  let diff;
  try {
    diff = execFileSync('diff', ['-u', '--label', 'upstream/rig.mjs', '--label', 'rig.mjs', 'upstream/rig.mjs', 'rig.mjs'], { cwd: rig, encoding: 'utf8' });
  } catch (error) {
    diff = error.stdout; // diff exits 1 when the files differ
  }
  assert.equal(diff, readFileSync(join(rig, 'rig.local.patch'), 'utf8'), 'regenerate rig.local.patch and record the change in test/rig/SOURCE.md');
});

test('rig provenance: the private tmux server never reads the user tmux.conf', () => {
  assert.match(readFileSync(join(rig, 'rig.mjs'), 'utf8'), /execFileSync\('tmux', \['-L', socket, '-f', '\/dev\/null'/);
});

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.host' || name === 'upstream') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(m?js)$/.test(name) ? [path] : [];
  });
}

test('rig provenance: no test imports from ~/.agents, a home directory or an absolute path', () => {
  for (const file of sources(here)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      assert.ok(!m[1].startsWith('/') && !m[1].includes('.agents') && !m[1].startsWith('~'), `${file} imports ${m[1]}`);
    }
  }
});
