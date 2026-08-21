#!/usr/bin/env node
// Installs the runtime into ~/.claude/claudapter and applies the hooks to the installed extension.
import { copyFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
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
