#!/usr/bin/env node
// Builds keeper/ into a .vsix and hands it to the VS Code CLI.
//
// Dropping the folder into ~/.vscode/extensions looks like it works and does not: since VS Code 1.74
// the folder scan is cached in extensions.json, and a folder that was never installed through the CLI
// stays out of that cache — it sits on disk and is never loaded. `code --install-extension` is the only
// way in that also registers it, and it is what makes the extension appear in the Extensions view where
// it can be disabled or removed like any other.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { buildVsix } from './vsix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'keeper');
const RUNTIME = path.join(homedir(), '.claude', 'claudapter');
const VSIX = path.join(RUNTIME, 'claudapter-keeper.vsix');

const pkg = JSON.parse(readFileSync(path.join(SRC, 'package.json'), 'utf8'));
const ID = `${pkg.publisher}.${pkg.name}`;

// A .cmd cannot be spawned directly on Windows since the Node 18.20/20.12 security fix, so it goes
// through a shell — and a shell takes one command line, not an argument vector, so the quoting is ours.
// Handing spawnSync the whole line and no args array is also what keeps DEP0190 quiet: the deprecation
// is about args being concatenated behind the caller's back, which is exactly what is not happening here.
function quote(arg) {
    return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function runCode(cli, args) {
    if (!/\.(cmd|bat)$/i.test(cli)) return spawnSync(cli, args, { encoding: 'utf8' });
    return spawnSync([cli, ...args].map(quote).join(' '), { shell: true, encoding: 'utf8' });
}

function candidates() {
    const home = homedir();
    if (platform() === 'win32') {
        const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        const programs = process.env.ProgramFiles || 'C:\\Program Files';
        return [
            path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
            path.join(programs, 'Microsoft VS Code', 'bin', 'code.cmd'),
            path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
        ];
    }
    if (platform() === 'darwin')
        return [
            '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            path.join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
        ];
    return ['/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code', '/usr/bin/code-insiders'];
}

// PATH first — a portable or non-standard install is only findable that way, and it is also the copy
// the user actually runs. `where` answers with both entries VS Code ships, and the extensionless one
// comes first: that is the bash script, which Windows cannot execute at all. Only the .cmd is runnable
// here, so the launchers are filtered rather than taking whatever line came back first.
function findCode() {
    const win = platform() === 'win32';
    const onPath = spawnSync(win ? 'where' : 'which', ['code'], { encoding: 'utf8' });
    if (onPath.status === 0) {
        const hits = String(onPath.stdout)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && (!win || /\.(cmd|bat|exe)$/i.test(line)));
        if (hits.length) return hits[0];
    }
    return candidates().find((c) => existsSync(c)) || null;
}

// spawnSync leaves stdout and stderr undefined when the process never started, which is exactly the
// case worth reporting clearly
function describe(out) {
    return (out.error ? out.error.message : String(out.stderr || out.stdout || '')).trim() || 'no output';
}

function build() {
    const files = readdirSync(SRC)
        .filter((name) => /\.(js|json|md)$/i.test(name))
        .map((name) => ({ name, data: readFileSync(path.join(SRC, name)) }));
    mkdirSync(RUNTIME, { recursive: true });
    writeFileSync(VSIX, buildVsix(pkg, files));
    return files.map((f) => f.name);
}

function installed(cli) {
    const list = runCode(cli, ['--list-extensions']);
    return String(list.stdout || '')
        .split(/\r?\n/)
        .some((line) => line.trim().toLowerCase() === ID.toLowerCase());
}

const cli = findCode();

if (process.argv.includes('--status')) {
    if (!cli) {
        console.log('keeper:    unknown (the VS Code CLI was not found)');
        process.exit(0);
    }
    console.log(`keeper:    ${installed(cli) ? `installed (${ID})` : 'not installed'}`);
    process.exit(0);
}

if (process.argv.includes('--remove')) {
    if (!cli) {
        console.log(`keeper: the VS Code CLI was not found — uninstall "${ID}" from the Extensions view.`);
        process.exit(0);
    }
    const out = runCode(cli, ['--uninstall-extension', ID]);
    console.log(out.status === 0 ? `keeper: uninstalled ${ID}` : `keeper: ${describe(out)}`);
    try {
        unlinkSync(VSIX);
    } catch {}
    process.exit(0);
}

const packed = build();
console.log(`keeper:    packed ${packed.length} file(s) → ${VSIX}`);

if (!cli) {
    console.log('  The VS Code CLI was not found, so the keeper was not installed. Install it by hand with:');
    console.log(`    code --install-extension "${VSIX}" --force`);
    console.log('  Without it the patch still has to be re-applied by hand after a Claude Code update.');
    process.exit(0);
}

// --force reinstalls over the same version, which is what a re-run of the installer is
const out = runCode(cli, ['--install-extension', VSIX, '--force']);
if (out.status !== 0) {
    console.log(`  install failed: ${describe(out)}`);
    console.log(`  Install it by hand with: code --install-extension "${VSIX}" --force`);
    process.exit(0);
}
console.log(`keeper:    installed ${ID} v${pkg.version} (${path.basename(cli)})`);
