#!/usr/bin/env node
// Installs the runtime into ~/.claude/claudapter and applies the hooks to the installed extension.
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(homedir(), '.claude', 'claudapter');

function copyDir(from, to) {
    mkdirSync(to, { recursive: true });
    let n = 0;
    for (const entry of readdirSync(from)) {
        const src = path.join(from, entry);
        if (statSync(src).isDirectory()) continue;
        copyFileSync(src, path.join(to, entry));
        n++;
    }
    return n;
}

mkdirSync(RUNTIME, { recursive: true });

// Carry state over from the pre-rename runtime directory, if one exists
const LEGACY_RUNTIME = path.join(homedir(), '.claude', 'ui-ext');
if (existsSync(LEGACY_RUNTIME)) {
    for (const file of ['bindings.json', 'chatgpt-auth.json', 'proxy.json']) {
        const from = path.join(LEGACY_RUNTIME, file);
        const to = path.join(RUNTIME, file);
        if (existsSync(from) && !existsSync(to)) {
            copyFileSync(from, to);
            console.log(`migrated: ${file}`);
        }
    }
}

for (const file of ['host.js', 'webview.js']) {
    copyFileSync(path.join(ROOT, 'src', file), path.join(RUNTIME, file));
    console.log(`runtime: ${file}`);
}

const proxySrc = path.join(ROOT, 'src', 'proxy');
if (existsSync(proxySrc)) console.log(`runtime: ${copyDir(proxySrc, path.join(RUNTIME, 'proxy'))} proxy file(s)`);

const mcpSrc = path.join(ROOT, 'src', 'mcp');
if (existsSync(mcpSrc)) console.log(`runtime: ${copyDir(mcpSrc, path.join(RUNTIME, 'mcp'))} mcp file(s)`);

// The patcher goes into the runtime too, so the keeper extension and the in-session watcher can
// re-apply the patch after a Claude Code update without the repository being on disk at all. It reads
// its own supported version out of the repo's package.json, which is not above it there — hence the
// stamp beside it. Not a package.json: host.js is CommonJS, and one carrying "type": "module" in this
// directory would break it.
// The repository goes along for one reason: when a signature moves, the frozen copy cannot heal itself,
// and the only useful thing left is to say whether the fix is already published. See the upstream check
// in apply-patch.mjs — nothing is ever downloaded from it, only a version number read.
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const stamp = { version: pkg.version, repository: pkg.repository?.url || pkg.repository || null };
copyFileSync(path.join(ROOT, 'scripts', 'apply-patch.mjs'), path.join(RUNTIME, 'apply-patch.mjs'));
writeFileSync(path.join(RUNTIME, 'patch-version.json'), `${JSON.stringify(stamp, null, 4)}\n`, 'utf8');
console.log(`runtime: apply-patch.mjs (${pkg.version})`);

// Template profiles are only added when missing — existing keys are never overwritten
const templates = path.join(ROOT, 'templates', 'profiles');
const profilesDir = path.join(homedir(), '.claude', 'profiles');
if (existsSync(templates)) {
    mkdirSync(profilesDir, { recursive: true });
    for (const entry of readdirSync(templates)) {
        const target = path.join(profilesDir, entry);
        if (existsSync(target)) continue;
        copyFileSync(path.join(templates, entry), target);
        console.log(`profile: ${entry} (template — set your models and key)`);
    }
}

console.log('');
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-patch.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit',
});

// The keeper is what makes the patch survive a Claude Code update on a window that comes up after it —
// see keeper/README.md. It is a separate extension, so --no-keeper opts out of installing one.
if (!process.argv.includes('--no-keeper')) {
    console.log('');
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'install-keeper.mjs')], { stdio: 'inherit' });
}
