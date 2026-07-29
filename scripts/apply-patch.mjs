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
        file: 'extension.js',
        find: 'e.iconPath={light:a,dark:a},',
        insert: '(()=>{try{' + HOST_REQUIRE + 'require(__p).attachPanel(e)}catch(__e){}})(),',
        where: 'after',
    },
    {
        file: 'extension.js',
        find: 'f.env=w,g)',
        replace: 'f.env=(()=>{try{' + HOST_REQUIRE + 'return require(__p).envFor(w,t)}catch(__e){return w}})(),g)',
        where: 'replace',
    },
    {
        file: 'webview/index.js',
        find: 'n.commandRegistry.registerAction({id:"model"',
        insert: '(globalThis.__ccx&&globalThis.__ccx.onRegistry&&globalThis.__ccx.onRegistry(n,b)),',
        where: 'before',
    },
    {
        file: 'webview/index.js',
        find: '["model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]',
        replace:
            '["ccx-provider","model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]/*__ccx*/',
        where: 'replace',
    },
];

const MARKER = '__ccx';

function findExtensionDir() {
    const argDir = process.argv.find((a) => a.startsWith('--dir='));
    if (argDir) return argDir.slice('--dir='.length);
    const root = path.join(homedir(), '.vscode', 'extensions');
    const dirs = readdirSync(root).filter((d) => d.startsWith('anthropic.claude-code-'));
    if (!dirs.length) throw Error(`Claude Code extension not found in ${root}`);
    return path.join(root, dirs.sort().at(-1));
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
            const hits = src.split(p.find).length - 1;
            if (hits !== 1) throw Error(`${rel}: signature matched ${hits} times — bundle changed:\n  ${p.find}`);
            const replacement =
                p.where === 'replace' ? p.replace : p.where === 'before' ? p.insert + p.find : p.find + p.insert;
            src = src.replace(p.find, replacement);
        }
        writeFileSync(file, src, 'utf8');
        checkSyntax(file);
        console.log(`patched ${rel} (${patches.length} hook(s))`);
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
