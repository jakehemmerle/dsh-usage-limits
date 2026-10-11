// Link the host packages the tests run against into test/.host/node_modules:
//   @deepseek-ai/*                 -> the dsh install's own scope (cordis, dsh-*)
//   @deepseek-harness-tui/dsh-tui  -> the dsh-TUI package the profile mounts
// Tests run with --preserve-symlinks so dsh-TUI's bare imports
// (@deepseek-ai/cordis, react) resolve exactly as the dsh Loader routes them.
//
// Override with DSH_TUI_DIR / DSH_SCOPE_DIR (e.g. a freshly built, patched
// dsh-tui from nix-config) — the e2e suite does that for the patched build.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'test', '.host', 'node_modules');

function dshScopeDir() {
  if (process.env.DSH_SCOPE_DIR) return process.env.DSH_SCOPE_DIR;
  const wrapper = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim();
  let bin = realpathSync(wrapper);
  // Jake's dsh is a shell wrapper that execs the store launcher.
  const text = readFileSync(bin, 'utf8');
  const exec = /exec\s+(\/nix\/store\/[^\s"]+\/bin\/dsh)/.exec(text);
  if (exec) bin = exec[1];
  const scope = join(dirname(dirname(bin)), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  if (!existsSync(join(scope, 'cordis'))) throw new Error(`no @deepseek-ai scope next to ${bin}; set DSH_SCOPE_DIR`);
  return scope;
}

function dshTuiDir() {
  if (process.env.DSH_TUI_DIR) return process.env.DSH_TUI_DIR;
  return realpathSync(join(homedir(), '.dsh', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui'));
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (lstatSync(path)) rmSync(path, { recursive: true, force: true });
  } catch { /* absent */ }
  symlinkSync(target, path);
}

const scope = dshScopeDir();
const tui = dshTuiDir();
link(scope, join(host, '@deepseek-ai'));
link(tui, join(host, '@deepseek-harness-tui', 'dsh-tui'));
if (process.argv.includes('--print')) console.log(JSON.stringify({ scope, tui }));
