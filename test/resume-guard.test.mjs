// The CLI writes <projects>/<slug>/<sessionId>.jsonl on the first user turn, not on system/init.
// So an id the CLI itself announced can still resume to nothing — a session launched and dead
// before anyone typed — and `--resume=<id>` answers "No conversation found with session ID …".
// The extension's own launchClaude() passes this.sessionId.value on every relaunch, so once the
// page has such an id every restart of that tab repeats the failure. envFor is the last hop before
// the SDK reads options.resume: it clears the field unless the transcript exists on disk.
//   node test/resume-guard.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-guard-${process.pid}`);
const projects = join(home, '.claude', 'projects', 'c--some-workspace');
const profiles = join(home, '.claude', 'profiles');
mkdirSync(projects, { recursive: true });
mkdirSync(profiles, { recursive: true });
mkdirSync(join(home, '.claude', 'claudapter'), { recursive: true });
writeFileSync(join(profiles, 'codex.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid/codex' } }));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-guard-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let envFor;
try {
    ({ envFor } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const REAL = 'aaaaaaaa-1111-4222-8333-444444444444';
const PHANTOM = 'bbbbbbbb-1111-4222-8333-444444444444';
writeFileSync(join(projects, `${REAL}.jsonl`), '{"type":"user"}\n');
writeFileSync(join(home, '.claude', 'claudapter', 'bindings.json'), JSON.stringify({ [REAL]: 'codex', [PHANTOM]: 'codex' }));

// 1. A resume whose transcript exists is left exactly alone — the profile applies through the binding.
let opts = { resume: REAL };
let env = envFor({ PATH: 'x' }, REAL, opts);
assert.equal(opts.resume, REAL, 'a real resume must not be touched');
assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid/codex', 'the binding for a real session must still apply');

// 2. A resume with no transcript is dropped from the options the SDK will read, so the CLI starts fresh.
opts = { resume: PHANTOM };
env = envFor({ PATH: 'x' }, PHANTOM, opts);
assert.equal(opts.resume, undefined, 'a phantom resume must be cleared from options');
// With the resume gone there is no binding to resolve — this spawn is a fresh session on whatever
// the pending profile says; here nothing is pending, so the base env comes back untouched.
assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'a dropped resume must not still resolve the phantom binding');

// 3. Same phantom, but a profile is pending for the tab: the fresh spawn takes that profile.
const S = globalThis.__ccxState;
S.pendingProfile = 'codex';
opts = { resume: PHANTOM };
env = envFor({ PATH: 'x' }, PHANTOM, opts);
assert.equal(opts.resume, undefined);
assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid/codex', 'the pending profile must apply to the fresh spawn');
S.pendingProfile = null;

// 4. Without the options object (an older injection point) the guard cannot clear anything, so it
//    must not pretend to: behaviour is exactly the pre-guard one.
env = envFor({ PATH: 'x' }, PHANTOM);
assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid/codex', 'no opts → no guard → binding still resolves');

// 5. Garbage is never treated as a session id worth scanning for.
opts = { resume: '../../etc/passwd' };
envFor({ PATH: 'x' }, opts.resume, opts);
assert.equal(opts.resume, undefined, 'a non-uuid resume is dropped, never used as a path');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — a --resume with no transcript on disk is dropped before the SDK sees it');
process.exit(0);
