// The terminal renderer owns Claude Code's built-in spellcheck UI; the VS Code composer does not. This
// checks the extension-host bridge instead: it sends only bounded Russian tokens to local Hunspell,
// returns misspellings without logging the draft, and preserves the request sequence for the webview.
//   node test/spellcheck.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-spellcheck-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
const settings = join(home, '.claude', 'settings.json');
mkdirSync(join(home, '.claude', 'profiles'), { recursive: true });
mkdirSync(runtime, { recursive: true });
copyFileSync(new URL('../src/webview.js', import.meta.url), join(runtime, 'webview.js'));
writeFileSync(settings, JSON.stringify({ spellcheck: { enabled: true, checker: 'hunspell', language: 'ru_RU' } }));
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
const childProcess = require('node:child_process');
const calls = [];

function fakeSpawn(command, args, options) {
    const child = new EventEmitter();
    let input = '';
    child.stdout = new PassThrough();
    child.stdin = new Writable({
        write(chunk, _encoding, callback) {
            input += chunk;
            callback();
        },
        final(callback) {
            process.nextTick(() => {
                // Hunspell -a emits `& word count offset: suggestions` for misspellings.
                child.stdout.end('& вловоав 1 0: проверка, слово\n');
                child.emit('close', 0);
            });
            callback();
        },
    });
    child.kill = () => child.emit('close', null);
    calls.push({ command, args, options, get input() { return input; } });
    return child;
}

Module._load = (request, ...rest) => {
    if (request === 'vscode') return { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } };
    if (request === 'child_process') return { ...childProcess, spawn: fakeSpawn };
    return load(request, ...rest);
};
const copy = join(tmpdir(), `ccx-host-spellcheck-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    Module._load = load;
    rmSync(copy, { force: true });
}

const handlers = [];
const posted = [];
renderScript(
    {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    },
    'nonce',
);
assert.equal(handlers.length, 1, 'host did not attach the webview receiver');

function receive(message) {
    handlers.forEach((fn) => fn(message));
}

function nextMessage(type) {
    return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error(`timed out waiting for ${type}`)), 1000);
        const poll = () => {
            const message = posted.find((m) => m.type === type);
            if (message) {
                clearTimeout(deadline);
                resolve(message);
            } else setTimeout(poll, 5);
        };
        poll();
    });
}

posted.length = 0;
receive({ type: 'ccx:spellcheck', seq: 73, words: ['проверка', 'вловоав', 'snake_case', 'проверка'] });
const result = await nextMessage('ccx:spellcheckResult');
assert.equal(result.seq, 73, 'response must belong to the originating input revision');
assert.deepEqual(result.unknown, ['вловоав'], 'only Hunspell misspellings should return to the webview');
assert.deepEqual(result.suggestions, { вловоав: ['проверка', 'слово'] }, 'Hunspell suggestions must reach the webview');
assert.equal(calls.length, 1, 'one bounded Hunspell process should serve one debounce batch');
assert.deepEqual(calls[0].args, ['-d', 'ru_RU', '-a'], 'configured dictionary and suggestion mode must be passed to Hunspell');
assert.equal(calls[0].input, 'проверка\nвловоав\n', 'only valid, unique Russian tokens may leave the webview');
assert.equal(calls[0].options.windowsHide, true, 'checking must not flash a console window on Windows');

rmSync(home, { recursive: true, force: true });
console.log('OK — local Hunspell receives bounded words and returns only misspellings');
process.exit(0);
