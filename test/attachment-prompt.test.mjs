// The draft written into an empty composer next to an attachment has to be in the language the answer
// will be in, which is `language` in ~/.claude/settings.json — what /config writes. The CLI accepts
// that setting as a name, a native name, a code or a full locale, so this pins that host.js resolves
// all four the same way, and that every language it claims to support actually has wording: a row
// missing from LANGUAGES falls back to English silently, which is the failure this is here to catch.
//   node test/attachment-prompt.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-lang-${process.pid}`);
const runtime = join(home, '.claude', 'claudapter');
const SETTINGS = join(home, '.claude', 'settings.json');
mkdirSync(join(home, '.claude', 'profiles'), { recursive: true });
mkdirSync(runtime, { recursive: true });
// renderScript reads the webview bundle out of the runtime dir and returns '' if it is missing, which
// would skip the ccx:state post this test reads.
copyFileSync(new URL('../src/webview.js', import.meta.url), join(runtime, 'webview.js'));

process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);

const copy = join(tmpdir(), `ccx-host-lang-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../src/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

// The prompts ride on ccx:state, which attachWebview posts as soon as the webview is attached — so
// this goes through the same wire the page reads, not through an internal the page never sees.
function promptsFor(language) {
    writeFileSync(SETTINGS, JSON.stringify(language === undefined ? {} : { language }));
    const seen = [];
    renderScript(
        {
            postMessage: (m) => {
                seen.push(m);
                return Promise.resolve(true);
            },
            onDidReceiveMessage: () => {},
            onDidDispose: () => {},
        },
        'nonce',
    );
    const state = seen.filter((m) => m.type === 'ccx:state').pop();
    assert.ok(state, 'no ccx:state was posted');
    assert.ok(state.attachmentPrompts, 'ccx:state carried no attachmentPrompts');
    return state.attachmentPrompts;
}

const RU = 'Проанализируй изображение в контексте этого диалога';
const EN = 'Analyse the image in the context of this conversation';

// 1. Every shape the CLI accepts for the setting has to land on the same language.
for (const value of ['russian', 'ru', 'ru-RU', 'русский', '  Russian  ']) {
    assert.equal(promptsFor(value).image, RU, `language "${value}" did not resolve to Russian`);
}

// 2. Unset, unusable or unknown falls back to English — the language the CLI itself falls back to.
for (const value of [undefined, '', 'klingon', 42]) {
    assert.equal(promptsFor(value).image, EN, `language ${JSON.stringify(value)} did not fall back to English`);
}

// 3. The four forms are what the webview picks between by counting chips and looking for thumbnails.
const en = promptsFor('english');
assert.equal(en.images, 'Analyse the images in the context of this conversation');
assert.equal(en.attachment, 'Analyse the attachment in the context of this conversation');
assert.equal(en.attachments, 'Analyse the attachments in the context of this conversation');

// 4. Completeness. This is the CLI's own list, read out of its resolver in resources/native-binary:
// claiming a language the table has no row for means a Greek user quietly gets English.
const CODES = 'en es fr ja de pt it ko hi id ru pl tr nl uk el cs da sv no'.split(' ');
for (const code of CODES) {
    const p = promptsFor(code);
    for (const key of ['image', 'images', 'attachment', 'attachments'])
        assert.ok(p[key] && typeof p[key] === 'string', `${code}.${key} is missing`);
    // Plural may legitimately equal singular (Japanese, Ukrainian), but a picture is never a file.
    assert.notEqual(p.image, p.attachment, `${code} words an image and an attachment the same`);
    if (code !== 'en') assert.notEqual(p.image, EN, `${code} fell through to English — no row in LANGUAGES`);
}

rmSync(home, { recursive: true, force: true });
console.log(`\nOK — the attachment draft follows /config language (${CODES.length} languages)`);
// attachWebview leaves fs.watch handles on settings, bindings and profiles; nothing unrefs them.
process.exit(0);
