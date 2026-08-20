// The VS Code composer needs the configured model and effort alongside the native Auto control. The host
// is the settings.json boundary, so this pins both fields on the ccx:state wire; the source checks keep
// the webview decoration from regressing into a terminal-only or stale-only indicator.
//   node test/model-effort-indicator.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-model-effort-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
const settings = join(home, '.claude', 'settings.json');
mkdirSync(join(home, '.claude', 'profiles'), { recursive: true });
mkdirSync(runtime, { recursive: true });
copyFileSync(new URL('../src/webview.js', import.meta.url), join(runtime, 'webview.js'));
writeFileSync(settings, JSON.stringify({ model: 'opus[1m]', effortLevel: 'xhigh' }));

process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);

const copy = join(tmpdir(), `ccx-host-model-effort-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

function stateFromHost() {
    const posted = [];
    renderScript(
        {
            postMessage: (message) => {
                posted.push(message);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: () => {},
            onDidDispose: () => {},
        },
        'nonce',
    );
    const state = posted.filter((message) => message.type === 'ccx:state').pop();
    assert.ok(state, 'host did not post ccx:state');
    return state;
}

let state = stateFromHost();
assert.equal(state.selectedModel, 'opus', 'the terminal-only [1m] marker must not reach the composer');
assert.equal(state.effortLevel, 'xhigh', 'configured effort must reach the composer');

writeFileSync(settings, JSON.stringify({ model: 'sonnet', effortLevel: 'max' }));
state = stateFromHost();
assert.equal(state.selectedModel, 'sonnet', 'the current model must be read from settings.json');
assert.equal(state.effortLevel, 'max', 'the current effort must be read from settings.json');

const page = readFileSync(new URL('../src/webview.js', import.meta.url), 'utf8');
assert.match(page, /selectedModel: d\.selectedModel \|\| null/);
assert.match(page, /effortLevel: d\.effortLevel \|\| null/);
assert.match(page, /function decorateModelAndEffort\(\)/);
assert.match(page, /ccx-model-effort/);
// the indicator must sit in the composer's toolbar row, left of the mode picker ("Auto"), which is the
// node before the submit button — never stretched into a bar of its own on the fieldset
assert.match(page, /function findIndicatorAnchor\(\)/);
assert.match(page, /button\[type="submit"\]/);
assert.match(page, /anchor\.parent\.insertBefore\(indicator, anchor\.before\)/);
assert.match(page, /flex:0 0 auto/);
assert.match(page, /function liveModel\(\)/);
assert.match(page, /function liveEffort\(\)/);
// the model must come from THIS session's live signals (selection → last served → current loop),
// never from the global settings default that names the wrong chat
assert.match(page, /\['modelSelection', 'lastServedModel', 'currentMainLoopModel'\]/);
assert.match(page, /lastServedModel: sessionField\('lastServedModel'\)/);
assert.doesNotMatch(page, /if \(!model \|\| model === 'default' \|\| model === 'auto'\) model = state\.selectedModel/);
// the [1m] context suffix must not leak into the chip, and an ultracode selection must show as such
assert.match(page, /function liveUltracode\(\)/);
assert.match(page, /liveUltracode\(\) \? 'ultracode'/);
assert.ok(page.includes(".replace(/\\[[^\\]]*\\]$/, '')"), 'the context suffix must be stripped');
assert.doesNotMatch(page, /document\.body\.appendChild\(indicator\)/);
assert.doesNotMatch(page, /top:8px;right:8px;z-index:10005/);
assert.match(page, /decorateModelAndEffort\(\);/);

rmSync(home, { recursive: true, force: true });
console.log('\nOK — model and effort reach the Composer indicator');
process.exit(0);
