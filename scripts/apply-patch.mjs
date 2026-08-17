#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST_REQUIRE =
    '/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","claudapter","host.js");' +
    'delete require.cache[require.resolve(__p)];';

const PATCHES = [
    {
        file: 'extension.js',
        find: '        <script nonce="${u}" src="${a}" type="module"></script>',
        insert:
            '        ${(()=>{try{' + HOST_REQUIRE + 'return require(__p).renderScript(e,u)}catch(__e){return ""}})()}\n',
        where: 'before',
    },
    {
        // Same story as #3: the icon local is renamed too (2.1.220–2.1.224 `light:a,dark:a`, 2.1.226 `light:s,dark:s`).
        // Anchoring on the shape — and on the `.webview.options=` that always follows — keeps the panel variable
        // available for the call, which is the one name the injected code actually needs.
        file: 'extension.js',
        find: /(\w+)\.iconPath=\{light:(\w+),dark:\2\},(\1\.webview\.options=)/,
        replace: (_found, panel, icon, tail) =>
            `${panel}.iconPath={light:${icon},dark:${icon}},(()=>{try{` +
            HOST_REQUIRE +
            `require(__p).attachPanel(${panel})}catch(__e){}})(),${tail}`,
        where: 'replace',
    },
    {
        // The minifier renames these locals on nearly every release (2.1.220: `f.env=w,g)`, 2.1.221–2.1.223:
        // `f.env=x,_)`, 2.1.224: `f.env=b,g)`, 2.1.226: `f.env=x,g)`, 2.1.227: `f.env=b;`), so the signature is
        // structural — the options object and the resolved env come out of the match.
        //
        // 2.1.227 changed the shape, not just the names: dropping the bundled-node fallback removed `nodePath`
        // from getClaudeBinary(), which took the whole `if(<comma-expr>,nodePath)f.executable=nodePath;` wrapper
        // with it. So the terminator is captured whole and re-emitted verbatim — `,<nodePath>)` on 2.1.220–2.1.226
        // keeps the enclosing `if(` arity intact, `;` on 2.1.227+ closes the bare statement.
        //
        // The resume id is read off the options object (`resume:t`) instead of the parameter, which is renamed too.
        // The object itself goes along as the third argument: envFor clears its `resume` when no transcript exists
        // for that id, and the SDK builds `--resume=<id>` from that field after this expression has run.
        file: 'extension.js',
        find: /(\w+)\.pathToClaudeCodeExecutable=(\w+),\1\.executableArgs=(\w+),\1\.env=(\w+)(,\w+\)|;)/,
        replace: (_found, opts, bin, args, env, tail) =>
            `${opts}.pathToClaudeCodeExecutable=${bin},${opts}.executableArgs=${args},${opts}.env=(()=>{try{` +
            HOST_REQUIRE +
            `return require(__p).envFor(${env},${opts}.resume,${opts})}catch(__e){return ${env}}})()${tail}`,
        where: 'replace',
    },
    {
        // The registry alone is not enough: the session — messages, busy, lastServedModel, send() — is a
        // different object entirely (class `MX`, while the registry hangs off `t_e`), and nothing reachable
        // from the context object leads to it. Both are in scope right here though, so the signature is
        // structural and hands the session over as well. Anchoring on the three reads that precede the
        // registration (`modelSelection`, `claudeConfig`, `lastServedModel`) is what pins the capture to the
        // session rather than to whatever else the minifier happens to call `t`, and the back-references keep
        // all three on the same object. One match in 2.1.227–2.1.233, always `session=t, ctx=n`.
        file: 'webview/index.js',
        find: /let (\w+)=(\w+)\.modelSelection\.value,(\w+)=\w+\(\2\.claudeConfig\.value\),(\w+)=\w+\(\1,\2\.lastServedModel\.value,\3\);(\w+)\.commandRegistry\.registerAction\(\{id:"model"/,
        replace: (found, _sel, session, _cfg, _label, ctx) =>
            found.replace(
                `${ctx}.commandRegistry.registerAction({id:"model"`,
                `(globalThis.__ccx&&globalThis.__ccx.onRegistry&&globalThis.__ccx.onRegistry(${ctx},b,${session})),` +
                    `${ctx}.commandRegistry.registerAction({id:"model"`,
            ),
        where: 'replace',
    },
    {
        file: 'webview/index.js',
        find: '["model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]',
        replace:
            '["ccx-provider","model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]/*__ccx*/',
        where: 'replace',
    },
];

// Things the injected code drives without patching them. Losing one is not an error — claudapter
// fails closed, the menu item is simply absent — but it is silent, and this is the only place the
// disappearance is visible before a user notices the gesture stopped working.
const EXPECTATIONS = [
    {
        file: 'webview/index.js',
        find: 'registerAction({id:"rewind"',
        what: 'the Rewind action — the "Rewind…" menu item and Ctrl+Shift+Z open it by id',
    },
];

const MARKER = '__ccx';

function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

// Old versions linger on disk after an update, so pick by version number rather than by name —
// "2.1.99" sorts above "2.1.222" lexically. Folders VS Code has already retired are skipped.
function findExtensionDir() {
    const argDir = process.argv.find((a) => a.startsWith('--dir='));
    if (argDir) return argDir.slice('--dir='.length);
    const root = path.join(homedir(), '.vscode', 'extensions');
    let obsolete = {};
    try {
        obsolete = JSON.parse(readFileSync(path.join(root, '.obsolete'), 'utf8')) || {};
    } catch {}
    const all = readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    const dirs = all.filter((d) => !obsolete[d]);
    if (!dirs.length) throw Error(`Claude Code extension not found in ${root}`);
    const newest = dirs.sort((a, b) => {
        const [x, y] = [versionOf(a), versionOf(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    }).at(-1);
    if (all.length > 1) console.log(`(${all.length} versions on disk, using the newest active one)`);
    return path.join(root, newest);
}

// Project version mirrors the extension version the signatures were verified against
function checkVersion(dir) {
    const supported = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const installed = (path.basename(dir).match(/anthropic\.claude-code-(\d+\.\d+\.\d+)/) || [])[1];
    console.log(`patcher:   ${supported}${installed && installed !== supported ? ` (installed ${installed})` : ''}`);
    if (installed && installed !== supported)
        console.log('  WARNING: versions differ. If the signatures changed, the patch will stop with an error.');
}

function backupPath(file) {
    return file + '.ccx-orig';
}

function restore(dir) {
    let n = 0;
    for (const rel of new Set(PATCHES.map((p) => p.file))) {
        const file = path.join(dir, rel);
        if (!existsSync(backupPath(file))) continue;
        copyFileSync(backupPath(file), file);
        n++;
    }
    console.log(n ? `Restored ${n} file(s) from backup.` : 'Nothing to restore.');
}

// A signature is either a literal string or a RegExp, for the spots where the minifier renames locals
function countHits(src, find) {
    if (typeof find === 'string') return src.split(find).length - 1;
    const flags = find.flags.includes('g') ? find.flags : find.flags + 'g';
    return (src.match(new RegExp(find.source, flags)) || []).length;
}

// Replacing through a function keeps `$` sequences in the injected code literal
function expand(patch, match) {
    const [found] = match;
    if (patch.where === 'before') return patch.insert + found;
    if (patch.where === 'after') return found + patch.insert;
    return typeof patch.replace === 'function' ? patch.replace(...match) : patch.replace;
}

function apply(dir) {
    const byFile = new Map();
    for (const p of PATCHES) {
        if (!byFile.has(p.file)) byFile.set(p.file, []);
        byFile.get(p.file).push(p);
    }

    for (const [rel, patches] of byFile) {
        const file = path.join(dir, rel);
        if (!existsSync(file)) throw Error(`missing ${file}`);
        if (!existsSync(backupPath(file))) copyFileSync(file, backupPath(file));

        let src = readFileSync(backupPath(file), 'utf8');
        for (const p of patches) {
            const hits = countHits(src, p.find);
            if (hits !== 1) throw Error(`${rel}: signature matched ${hits} times — bundle changed:\n  ${p.find}`);
            src = src.replace(p.find, (...match) => expand(p, match));
        }
        writeFileSync(file, src, 'utf8');
        checkSyntax(file);
        console.log(`patched ${rel} (${patches.length} hook(s))`);
    }
    checkExpectations(dir);
}

// Read from the backup: by now the file itself is patched, and an expectation is about their code
function checkExpectations(dir) {
    for (const e of EXPECTATIONS) {
        const file = backupPath(path.join(dir, e.file));
        if (!existsSync(file)) continue;
        if (countHits(readFileSync(file, 'utf8'), e.find) === 0)
            console.log(`  NOTE: ${e.file} no longer has ${e.what}. That feature is off; nothing else is affected.`);
    }
}

function checkSyntax(file) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        return;
    } catch (cjsError) {
        const asModule = file + '.ccx-check.mjs';
        try {
            copyFileSync(file, asModule);
            execFileSync(process.execPath, ['--check', asModule], { stdio: 'pipe' });
        } catch {
            throw Error(`syntax check failed for ${file}:\n${cjsError.stderr}`);
        } finally {
            try {
                unlinkSync(asModule);
            } catch {}
        }
    }
}

function status(dir) {
    for (const rel of new Set(PATCHES.map((p) => p.file))) {
        const file = path.join(dir, rel);
        const patched = existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
        console.log(`${patched ? 'patched  ' : 'clean    '} ${rel}`);
    }
}

const dir = findExtensionDir();
console.log(`extension: ${dir}`);
checkVersion(dir);
if (process.argv.includes('--revert')) restore(dir);
else if (process.argv.includes('--status')) status(dir);
else {
    apply(dir);
    console.log('\nDone. Reload VS Code window (Ctrl+Shift+P → Developer: Reload Window).');
}
