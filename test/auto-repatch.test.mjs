// Pins the contract the automatic re-apply rides on. Three parties speak it — the patcher prints it,
// the keeper extension and the in-session watcher parse it — and none of them imports the others, so
// the strings are checked against all three sources here rather than trusted to stay in step.
//
// The safety property is the important one: an auto-apply that meets a bundle whose signatures moved
// must leave that bundle byte for byte as it found it and must not claim success. Nothing else makes
// running the patcher unattended defensible.
import { spawn, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { buildVsix } from '../scripts/vsix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCHER = path.join(ROOT, 'scripts', 'apply-patch.mjs');
const WORK = path.join(tmpdir(), `ccx-repatch-${process.pid}`);

// Every case is offline unless it says otherwise: a test suite that reaches the real GitHub is a test
// suite that fails on a plane. The upstream cases below override the switch and point the check at a
// server on this machine.
function envFor(overrides) {
    const env = { ...process.env, CCX_NO_UPSTREAM_CHECK: '1' };
    for (const [key, value] of Object.entries(overrides || {}))
        if (value === null) delete env[key];
        else env[key] = value;
    return env;
}

function run(patcher, args, overrides) {
    const out = spawnSync(process.execPath, [patcher, ...args], { encoding: 'utf8', env: envFor(overrides) });
    return { code: out.status, text: `${out.stdout || ''}${out.stderr || ''}` };
}

// The upstream server below lives in this process, and spawnSync blocks this process's event loop —
// it would never answer, and the patcher would time out against a server that is right here. Every run
// that talks to it has to be the asynchronous one.
function runAsync(patcher, args, overrides) {
    return new Promise((done) => {
        const child = spawn(process.execPath, [patcher, ...args], { env: envFor(overrides) });
        let text = '';
        child.stdout.on('data', (chunk) => (text += chunk));
        child.stderr.on('data', (chunk) => (text += chunk));
        child.on('close', (code) => done({ code, text }));
    });
}

function fixture(name, files) {
    const dir = path.join(WORK, name);
    for (const [rel, body] of Object.entries(files)) {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body, 'utf8');
    }
    return dir;
}

// The apply path needs a bundle the signatures actually match, and the only one in existence is the
// installed extension. Where Claudapter is installed the untouched copy is the backup; where it is not,
// extension.js is itself untouched. Both are real releases, which is the point — a hand-written stand-in
// would only prove that the stand-in matches.
function cleanBundle() {
    const root = path.join(homedir(), '.vscode', 'extensions');
    let obsolete = {};
    try {
        obsolete = JSON.parse(readFileSync(path.join(root, '.obsolete'), 'utf8')) || {};
    } catch {}
    const dir = readdirSync(root)
        .filter((name) => name.startsWith('anthropic.claude-code-') && !obsolete[name])
        .sort((a, b) => {
            const version = (name) => (name.match(/-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
            const [x, y] = [version(a), version(b)];
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        })
        .pop();
    assert.ok(dir, `no Claude Code extension under ${root} — the apply path cannot be exercised`);

    const files = {};
    for (const rel of ['extension.js', 'webview/index.js']) {
        const file = path.join(root, dir, rel);
        const backup = `${file}.ccx-orig`;
        const body = readFileSync(existsSync(backup) ? backup : file, 'utf8');
        assert.ok(!body.includes('__ccx'), `${rel} is patched and has no backup beside it`);
        files[rel] = body;
    }
    return files;
}

rmSync(WORK, { recursive: true, force: true });

try {
    // --- the two result lines --------------------------------------------------------------------
    const patched = fixture('anthropic.claude-code-9.9.9-patched', {
        'extension.js': 'void 0;/*__ccx*/\n',
        'webview/index.js': 'void 0;/*__ccx*/\n',
    });

    const upToDate = run(PATCHER, [`--dir=${patched}`, '--if-needed']);
    assert.equal(upToDate.code, 0, `--if-needed on a patched bundle failed:\n${upToDate.text}`);
    assert.match(upToDate.text, /^ccx-result: up-to-date$/m, 'no up-to-date line for a patched bundle');
    assert.doesNotMatch(upToDate.text, /^ccx-result: patched$/m, 'a patched bundle must not report a fresh patch');
    console.log('OK — --if-needed leaves an already patched bundle alone and says so');

    // --- a bundle whose signatures moved ----------------------------------------------------------
    const SOURCE = 'export const nothing = 1;\n';
    const moved = fixture('anthropic.claude-code-9.9.9-moved', {
        'extension.js': SOURCE,
        'webview/index.js': SOURCE,
    });

    const refused = run(PATCHER, [`--dir=${moved}`, '--if-needed']);
    assert.notEqual(refused.code, 0, 'a bundle with no matching signature must fail loudly');
    assert.match(refused.text, /signature matched 0 times/, `unexpected failure:\n${refused.text}`);
    assert.doesNotMatch(refused.text, /^ccx-result:/m, 'a refused run must not report a result');
    assert.equal(readFileSync(path.join(moved, 'extension.js'), 'utf8'), SOURCE, 'extension.js was written to');
    assert.equal(readFileSync(path.join(moved, 'webview', 'index.js'), 'utf8'), SOURCE, 'index.js was written to');
    assert.ok(!existsSync(path.join(moved, '.ccx.lock')), 'a failed run left its lock behind');
    console.log('OK — a moved signature stops the patcher with the bundle untouched and no result line');

    // --- one writer at a time ---------------------------------------------------------------------
    // VS Code restores every window at once and each one activates the keeper, so several patchers meet
    // over the same 2.7 MB bundle. Restore-from-backup and write-back is not atomic, so they queue.
    assert.ok(!existsSync(path.join(patched, '.ccx.lock')), 'a finished run left its lock behind');

    const lock = path.join(patched, '.ccx.lock');
    writeFileSync(lock, String(process.pid));
    const started = Date.now();
    const queued = new Promise((done) => {
        const child = spawn(process.execPath, [PATCHER, `--dir=${patched}`, '--if-needed'], { stdio: 'ignore' });
        child.on('close', (code) => done({ code, waited: Date.now() - started }));
    });
    await new Promise((go) => setTimeout(go, 1200));
    rmSync(lock, { force: true });

    const held = await queued;
    assert.equal(held.code, 0, 'the queued run did not finish once the lock was released');
    assert.ok(held.waited >= 1000, `the run did not wait for the lock (${held.waited} ms)`);
    console.log('OK — a run waits for the lock another one holds instead of writing over it');

    // A crashed run leaves its lock behind, and nothing else would ever clear it
    writeFileSync(lock, 'crashed');
    const ancient = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, ancient, ancient);
    const stale = run(PATCHER, [`--dir=${patched}`, '--if-needed']);
    assert.equal(stale.code, 0, `a stale lock blocked the patcher:\n${stale.text}`);
    assert.match(stale.text, /^ccx-result: up-to-date$/m, 'the run behind a stale lock reported nothing');
    assert.ok(!existsSync(lock), 'the stale lock was not cleared');
    console.log('OK — a lock left behind by a crashed run is taken over, not waited on forever');

    // --- an update to a version nobody verified ---------------------------------------------------
    // The version check is a warning, not a stop, and that is deliberate: most signatures match the
    // shape of the code rather than the names in it, so a new release usually takes the patch fine —
    // refusing on the version number alone would turn every update into manual work for nothing. What
    // must not happen is the patch going on silently. A hand-run patch prints the mismatch for someone
    // who is reading it; an automatic run has no reader, so it has to leave through the result lines.
    const source = cleanBundle();
    const supported = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const ahead = supported.replace(/\d+$/, (last) => Number(last) + 1);
    const escape = (v) => v.replace(/\./g, '\\.');

    const onAhead = run(PATCHER, [`--dir=${fixture(`anthropic.claude-code-${ahead}-win32-x64`, source)}`, '--if-needed']);
    assert.equal(onAhead.code, 0, `the patch did not go onto ${ahead}:\n${onAhead.text.slice(-1500)}`);
    assert.match(onAhead.text, /^ccx-result: patched$/m, 'a fresh patch reported nothing');
    assert.match(
        onAhead.text,
        new RegExp(`^ccx-unverified: ${escape(ahead)} ${escape(supported)}$`, 'm'),
        `a patch onto an unverified version did not say so:\n${onAhead.text}`,
    );
    assert.doesNotMatch(onAhead.text, /^ccx-upstream:/m, 'the upstream check ran with CCX_NO_UPSTREAM_CHECK set');
    console.log(`OK — a patch onto ${ahead}, which nothing verified, applies and reports the mismatch`);

    // --- is the fix already published? ------------------------------------------------------------
    // The patcher that runs unattended is a frozen copy and cannot heal itself, so when it meets a
    // version it does not know, the one useful thing left is whether a release that does know it
    // exists. That is one GET of a published package.json, answered here by a server on this machine.
    const published = { version: ahead };
    const upstream = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(published));
    });
    await new Promise((listening) => upstream.listen(0, '127.0.0.1', listening));
    const CCX_UPSTREAM_URL = `http://127.0.0.1:${upstream.address().port}/package.json`;

    try {
        const asked = await runAsync(
            PATCHER,
            [`--dir=${fixture(`anthropic.claude-code-${ahead}-covered`, source)}`, '--if-needed'],
            { CCX_NO_UPSTREAM_CHECK: null, CCX_UPSTREAM_URL },
        );
        assert.match(
            asked.text,
            new RegExp(`^ccx-upstream: ${escape(ahead)} covers$`, 'm'),
            `a published release covering ${ahead} was not reported:\n${asked.text}`,
        );
        console.log(`OK — a release that covers ${ahead} is found and reported as covering it`);

        published.version = supported;
        const stillBehind = await runAsync(
            PATCHER,
            [`--dir=${fixture(`anthropic.claude-code-${ahead}-behind`, source)}`, '--if-needed'],
            { CCX_NO_UPSTREAM_CHECK: null, CCX_UPSTREAM_URL },
        );
        assert.match(
            stillBehind.text,
            new RegExp(`^ccx-upstream: ${escape(supported)} behind$`, 'm'),
            `a release older than the installed extension was not marked behind:\n${stillBehind.text}`,
        );
        console.log('OK — a release that has not caught up yet is reported as behind, not as a fix');

        // The every-window path. It must never reach the network, published release or not.
        const quiet = await runAsync(PATCHER, [`--dir=${patched}`, '--if-needed'], {
            CCX_NO_UPSTREAM_CHECK: null,
            CCX_UPSTREAM_URL,
        });
        assert.match(quiet.text, /^ccx-result: up-to-date$/m, 'the quiet path stopped reporting');
        assert.doesNotMatch(quiet.text, /^ccx-upstream:/m, 'an already patched bundle asked about releases');
        console.log('OK — the path that runs on every window never asks about releases');

        // A refused patch is exactly when the answer matters, and it must not swallow the exit code
        const refusedAndAsked = await runAsync(PATCHER, [`--dir=${moved}`, '--if-needed'], {
            CCX_NO_UPSTREAM_CHECK: null,
            CCX_UPSTREAM_URL,
        });
        assert.notEqual(refusedAndAsked.code, 0, 'the upstream check swallowed a failure');
        assert.match(refusedAndAsked.text, /^ccx-upstream: /m, 'a refused patch did not ask about releases');
        console.log('OK — a refused patch reports the published release and still fails');
    } finally {
        upstream.close();
    }

    const named = fixture(`anthropic.claude-code-${supported}-win32-x64`, source);
    const onNamed = run(PATCHER, [`--dir=${named}`, '--if-needed']);
    assert.equal(onNamed.code, 0, `the patch did not go onto ${supported}:\n${onNamed.text.slice(-1500)}`);
    assert.doesNotMatch(onNamed.text, /^ccx-unverified:/m, 'the verified version was flagged as unverified');
    console.log(`OK — ${supported}, the version the signatures were checked against, is not flagged`);

    // --- the runtime copy finds its version without the repository --------------------------------
    // install.mjs drops the patcher into ~/.claude/claudapter, where ../package.json is ~/.claude's,
    // not the project's — the stamp beside it is what keeps the version line honest there
    const runtime = path.join(WORK, 'runtime');
    mkdirSync(runtime, { recursive: true });
    const runtimePatcher = path.join(runtime, 'apply-patch.mjs');
    writeFileSync(runtimePatcher, readFileSync(PATCHER));
    writeFileSync(path.join(runtime, 'patch-version.json'), JSON.stringify({ version: '9.9.9' }));

    const stamped = run(runtimePatcher, [`--dir=${patched}`, '--if-needed']);
    assert.equal(stamped.code, 0, `the runtime copy failed:\n${stamped.text}`);
    assert.match(stamped.text, /^patcher: +9\.9\.9$/m, `the version stamp was not read:\n${stamped.text}`);
    console.log('OK — the runtime copy of the patcher reads its version from the stamp beside it');

    // --- all three parties agree on the wording ---------------------------------------------------
    const patcherSrc = readFileSync(PATCHER, 'utf8');
    const keeperSrc = readFileSync(path.join(ROOT, 'keeper', 'extension.js'), 'utf8');
    const hostSrc = readFileSync(path.join(ROOT, 'src', 'host.js'), 'utf8');

    assert.match(patcherSrc, /upToDate: 'ccx-result: up-to-date'/, 'the patcher no longer prints up-to-date');
    assert.match(patcherSrc, /patched: 'ccx-result: patched'/, 'the patcher no longer prints patched');
    assert.match(patcherSrc, /unverified: 'ccx-unverified:'/, 'the patcher no longer prints the version mismatch');
    assert.match(patcherSrc, /upstream: 'ccx-upstream:'/, 'the patcher no longer reports the published release');
    assert.match(keeperSrc, /ccx-result: patched/, 'the keeper no longer looks for the patched line');
    assert.match(hostSrc, /ccx-result: patched/, 'the host watcher no longer looks for the patched line');
    for (const [who, src] of [
        ['the keeper', keeperSrc],
        ['the host watcher', hostSrc],
    ]) {
        assert.match(src, /\^ccx-unverified: \(\\S\+\) \(\\S\+\)\$/, `${who} no longer reads the version mismatch`);
        assert.match(src, /\^ccx-upstream: \(\\S\+\) \(\\S\+\)\$/, `${who} no longer reads the published release`);
        assert.match(src, /'--if-needed'/, `${who} no longer calls the patcher with --if-needed`);
    }
    console.log('OK — patcher, keeper and host watcher still speak the same result lines');

    // --- the .vsix is a ZIP the VS Code CLI can open -----------------------------------------------
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'keeper', 'package.json'), 'utf8'));
    const files = readdirSync(path.join(ROOT, 'keeper'))
        .filter((name) => /\.(js|json|md)$/i.test(name))
        .map((name) => ({ name, data: readFileSync(path.join(ROOT, 'keeper', name)) }));
    const vsix = buildVsix(pkg, files);

    const eocd = vsix.length - 22;
    assert.equal(vsix.readUInt32LE(eocd), 0x06054b50, 'no end-of-central-directory record');
    assert.equal(vsix.readUInt16LE(eocd + 10), files.length + 2, 'wrong entry count — manifest or content types lost');
    assert.equal(vsix.readUInt32LE(0), 0x04034b50, 'the archive does not start with a local file header');

    // Walk the central directory the way a reader does, and inflate every entry back to its source
    const names = new Map();
    let cursor = vsix.readUInt32LE(eocd + 16);
    for (let i = 0; i < files.length + 2; i++) {
        assert.equal(vsix.readUInt32LE(cursor), 0x02014b50, `central header ${i} is malformed`);
        const nameLen = vsix.readUInt16LE(cursor + 28);
        const name = vsix.toString('utf8', cursor + 46, cursor + 46 + nameLen);
        const local = vsix.readUInt32LE(cursor + 42);
        const start = local + 30 + vsix.readUInt16LE(local + 26) + vsix.readUInt16LE(local + 28);
        const body = inflateRawSync(vsix.subarray(start, start + vsix.readUInt32LE(cursor + 20)));
        assert.equal(body.length, vsix.readUInt32LE(cursor + 24), `${name}: inflated to the wrong length`);
        names.set(name, body);
        cursor += 46 + nameLen + vsix.readUInt16LE(cursor + 30) + vsix.readUInt16LE(cursor + 32);
    }

    assert.ok(names.has('extension.vsixmanifest'), 'no vsixmanifest — VS Code would reject the package');
    assert.ok(names.has('[Content_Types].xml'), 'no content types map');
    assert.deepEqual(
        JSON.parse(names.get('extension/package.json').toString('utf8')),
        pkg,
        'the packed manifest is not the keeper manifest',
    );
    // The id install-keeper.mjs uninstalls by has to be the one the manifest declares
    assert.match(
        names.get('extension.vsixmanifest').toString('utf8'),
        new RegExp(`Id="${pkg.name}" Version="${pkg.version.replace(/\./g, '\\.')}" Publisher="${pkg.publisher}"`),
        'the vsixmanifest identity drifted from keeper/package.json',
    );
    console.log('OK — the keeper packs into a .vsix that reads back as a valid ZIP');
} finally {
    rmSync(WORK, { recursive: true, force: true });
}

assert.ok(!existsSync(WORK), 'the fixtures were left behind');
