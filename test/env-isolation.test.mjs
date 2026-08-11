// envFor() is the whole point of the patch — it decides what a `claude` process is launched with —
// and nothing exercised it until a credential leak turned up in review. This pins the two rules that
// matter: nothing that authenticates you to Anthropic may cross into a third-party provider, and the
// Anthropic subscription profile must keep using exactly what it inherited.
//
// host.js requires('vscode') and is CommonJS while this package is ESM, so it is loaded the same way
// test/profile-icons.test.mjs does it: a .cjs copy plus a 'vscode' stub. HOME is redirected to a temp
// tree first, because the module resolves ~/.claude/profiles at load time.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-env-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'claudapter');
mkdirSync(profiles, { recursive: true });
mkdirSync(runtime, { recursive: true });

// A provider that redirects traffic, and the "Anthropic subscription" profile, which declares nothing.
writeFileSync(
    join(profiles, 'deepseek.json'),
    JSON.stringify({
        env: {
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'sk-deepseek',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
        },
    }),
);
writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));
// Same endpoint, different account. No base URL, so a gate keyed on ANTHROPIC_BASE_URL would let the
// ambient ANTHROPIC_API_KEY through — and the CLI reads that one first, so this profile's token loses.
writeFileSync(join(profiles, 'secondaccount.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-second' } }));
writeFileSync(
    join(runtime, 'bindings.json'),
    JSON.stringify({ 'sess-third-party': 'deepseek', 'sess-anthropic': 'claude', 'sess-second': 'secondaccount' }),
);

process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const warnings = [];
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? {
              Uri: { file: (p) => ({ fsPath: p }) },
              window: { showWarningMessage: (m) => warnings.push(m), showErrorMessage: () => {} },
          }
        : load(request, ...rest);

const copy = join(tmpdir(), `ccx-host-env-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));

let envFor;
try {
    ({ envFor } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

// What a user who authenticates to Anthropic by key would have in the ambient environment. Note that
// no profile declares ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, so the union-of-profile-keys rule
// alone never removes them.
const ambient = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-REAL-USER-KEY',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-REAL-USER-TOKEN',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-legacy',
};

const third = envFor(ambient, 'sess-third-party');

for (const leaked of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.ok(
        !(leaked in third),
        `${leaked} survived into a third-party provider's environment — that ships the user's Anthropic ` +
            `credential to DeepSeek, and the CLI resolves ANTHROPIC_API_KEY before ANTHROPIC_AUTH_TOKEN, ` +
            `so it also breaks the profile's own auth`,
    );
}
assert.equal(third.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic', 'profile base URL not applied');
assert.equal(third.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek', 'profile token not applied');
assert.equal(third.PATH, '/usr/bin', 'unrelated environment must be preserved');

// The subscription profile declares nothing, so it must not have its inherited credentials stripped.
const anthropic = envFor(ambient, 'sess-anthropic');
assert.equal(anthropic.ANTHROPIC_API_KEY, 'sk-ant-REAL-USER-KEY', 'subscription profile lost its ambient key');
assert.equal(anthropic.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-REAL-USER-TOKEN', 'subscription profile lost its OAuth token');

// A profile that only swaps the token still counts as crossing: it declares a credential, so the
// ambient one has to go or it would outrank the profile's.
const second = envFor(ambient, 'sess-second');
assert.ok(!('ANTHROPIC_API_KEY' in second), 'ambient key outranks a token-only profile and must be stripped');
assert.equal(second.ANTHROPIC_AUTH_TOKEN, 'sk-ant-second', 'token-only profile did not take effect');

// No binding, no profile: the environment is passed through untouched, by identity.
assert.strictEqual(envFor(ambient, 'sess-unknown'), ambient, 'unbound session must pass the environment through');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — credentials do not cross a provider change');
