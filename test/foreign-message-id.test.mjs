// A session that answered on a non-Anthropic backend carries that provider's message ids in its
// transcript — OpenRouter's are `gen-1787815743-…`. The CLI feeds the last one back as
// `diagnostics.previous_message_id`, but only when the request goes to Anthropic, and Anthropic
// rejects anything that is not `msg_…` with a 400. Nothing retries without the field and a relaunch
// re-reads the id off disk, so the session stays unreachable until the id is gone. envFor is the
// last hop before the spawn: it drops those ids, and only on the spawn that is going to Anthropic.
//   node test/foreign-message-id.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-msgid-${process.pid}`);
const projects = join(home, '.claude', 'projects', 'c--some-workspace');
const profiles = join(home, '.claude', 'profiles');
const state = join(home, '.claude', 'claudapter');
mkdirSync(projects, { recursive: true });
mkdirSync(profiles, { recursive: true });
mkdirSync(state, { recursive: true });
writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));
writeFileSync(
    join(profiles, 'openrouter.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: 'sk-or-x' } }),
);
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-msgid-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let envFor;
try {
    ({ envFor } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const SESSION = 'cccccccc-1111-4222-8333-444444444444';
const file = join(projects, `${SESSION}.jsonl`);

// Everything a real transcript puts next to the id: a user turn, the foreign answer, an Anthropic
// one from before the switch, an answer with no id at all, a line half-written by a live CLI, and a
// sidecar record that is not a turn.
const FOREIGN = '{"type":"assistant","uuid":"u1","message":{"role":"assistant","id":"gen-1787815743-Wd0oDf0iH9SHXerqJ6DS","model":"minimax/minimax-m3:free","content":[{"type":"text","text":"hi"}]}}';
const NATIVE = '{"type":"assistant","uuid":"u2","message":{"role":"assistant","id":"msg_01ABCDEF","model":"claude-opus-5","content":[]}}';
const NO_ID = '{"type":"assistant","uuid":"u3","message":{"role":"assistant","model":"claude-opus-5","content":[]}}';
const USER = '{"type":"user","uuid":"u0","message":{"role":"user","content":"тест"}}';
const HALF = '{"type":"assistant","uuid":"u4","message":{"role":"assist';
const SIDECAR = '{"type":"last-prompt","lastPrompt":"тест"}';
const original = [USER, FOREIGN, NATIVE, NO_ID, SIDECAR, HALF].join('\n');

const reset = () => writeFileSync(file, original, 'utf8');
const lines = () => readFileSync(file, 'utf8').split('\n');
const S = globalThis.__ccxState;

// 1. The spawn goes to OpenRouter: the ids are that provider's own and none of its business to fix.
reset();
writeFileSync(join(state, 'bindings.json'), JSON.stringify({ [SESSION]: 'openrouter' }));
let env = envFor({ PATH: 'x' }, SESSION, { resume: SESSION });
assert.equal(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api', 'the binding must still route the spawn');
assert.equal(readFileSync(file, 'utf8'), original, 'a spawn that is not going to Anthropic must not touch the transcript');

// 2. The tab switches back to the Anthropic subscription: the foreign id goes, nothing else moves.
S.pendingProfile = 'claude';
envFor({ PATH: 'x' }, SESSION, { resume: SESSION });
let out = lines();
assert.equal(out.length, 6, 'the line count must survive the rewrite');
assert.equal(out[0], USER, 'a user turn is not an assistant turn');
assert.equal(JSON.parse(out[1]).message.id, undefined, 'the foreign id must be gone');
assert.equal(JSON.parse(out[1]).message.model, 'minimax/minimax-m3:free', 'the rest of the answer must survive');
assert.equal(JSON.parse(out[1]).uuid, 'u1', 'the uuid the page keys on must survive');
assert.equal(out[2], NATIVE, "an id Anthropic itself issued is left byte for byte");
assert.equal(out[3], NO_ID, 'an answer with no id is left byte for byte');
assert.equal(out[4], SIDECAR, 'a record that is not a turn is left byte for byte');
assert.equal(out[5], HALF, 'a half-written trailing line must survive verbatim');

// 3. Running again changes nothing — there is no second id to find and the file is left alone.
const afterFirst = readFileSync(file, 'utf8');
envFor({ PATH: 'x' }, SESSION, { resume: SESSION });
assert.equal(readFileSync(file, 'utf8'), afterFirst, 'the strip must be idempotent');

// 4. A tab carrying no profile at all is the plainest way back to Anthropic, and is covered too.
reset();
S.pendingProfile = null;
writeFileSync(join(state, 'bindings.json'), JSON.stringify({}));
envFor({ PATH: 'x' }, SESSION, { resume: SESSION });
assert.equal(JSON.parse(lines()[1]).message.id, undefined, 'no profile means the ambient Anthropic route');

// 5. …unless the ambient route is not Anthropic: then the spawn is someone else's and the ids are
//    not ours to rewrite.
reset();
envFor({ PATH: 'x', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, SESSION, { resume: SESSION });
assert.equal(readFileSync(file, 'utf8'), original, 'an ambient non-Anthropic base url must be respected');

// 6. settings.json outranks the ambient environment the same way the CLI applies it.
reset();
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' } }));
envFor({ PATH: 'x' }, SESSION, { resume: SESSION });
assert.equal(readFileSync(file, 'utf8'), original, 'settings.json pointing elsewhere must be respected');

// 7. A resume with no transcript is dropped by the guard first, so there is nothing to strip and
//    nothing to throw on.
rmSync(join(home, '.claude', 'settings.json'), { force: true });
const opts = { resume: 'dddddddd-1111-4222-8333-444444444444' };
envFor({ PATH: 'x' }, opts.resume, opts);
assert.equal(opts.resume, undefined, 'the resume guard still runs ahead of the strip');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — a foreign previous_message_id is stripped before the tab spawns back onto Anthropic');
process.exit(0);
