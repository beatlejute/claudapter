#!/usr/bin/env node
// Registers the delegated-agent MCP server with Claude Code, at user scope so every project and
// every tab can reach it.
//
//   node scripts/install-mcp.mjs            # register (re-registering replaces the old entry)
//   node scripts/install-mcp.mjs --status   # show what is registered
//   node scripts/install-mcp.mjs --remove   # unregister
//
// The server is registered from ~/.claude/claudapter, not from this checkout: that is the copy
// `npm run setup` refreshes, so an update reaches the registered server without re-registering.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const NAME = 'claudapter-agents';
const RUNTIME = path.join(homedir(), '.claude', 'claudapter');
const SERVER = path.join(RUNTIME, 'mcp', 'agent-server.mjs');

function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function resolveClaudeBinary() {
    const root = path.join(homedir(), '.vscode', 'extensions');
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    try {
        const dir = readdirSync(root)
            .filter((d) => d.startsWith('anthropic.claude-code-'))
            .sort((a, b) => {
                const [x, y] = [versionOf(a), versionOf(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            })
            .pop();
        if (dir) {
            const bin = path.join(root, dir, 'resources', 'native-binary', exe);
            if (existsSync(bin)) return bin;
        }
    } catch {}
    return exe; // fall back to PATH
}

const claude = resolveClaudeBinary();
const run = (...args) => spawnSync(claude, ['mcp', ...args], { encoding: 'utf8', windowsHide: true });

if (process.argv.includes('--status')) {
    const out = run('list');
    process.stdout.write(out.stdout || out.stderr || '');
    process.exit(out.status ?? 0);
}

if (process.argv.includes('--remove')) {
    const out = run('remove', NAME, '--scope', 'user');
    process.stdout.write(out.stdout || out.stderr || '');
    process.exit(out.status ?? 0);
}

if (!existsSync(SERVER)) {
    console.error(`not found: ${SERVER}\nRun "npm run setup" first — it copies the runtime into ~/.claude/claudapter.`);
    process.exit(1);
}

// `mcp add` refuses a name that already exists, so a re-register drops the old entry first. A
// missing entry makes remove fail, which is the normal first-install path and not an error.
run('remove', NAME, '--scope', 'user');

const added = run('add', NAME, '--scope', 'user', '--', process.execPath, SERVER);
process.stdout.write(added.stdout || '');
if (added.status !== 0) {
    process.stderr.write(added.stderr || '');
    process.exit(added.status ?? 1);
}

console.log(`\nRegistered "${NAME}" (user scope) → ${process.execPath} ${SERVER}`);
console.log('Reload the VS Code window, then ask Claude to run a task on another profile.');
