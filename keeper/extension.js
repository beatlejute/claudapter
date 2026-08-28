'use strict';

// The patch lives inside the Claude Code extension folder, and an update installs a new folder — so
// every update silently reverts it. The running host cannot fix that on its own: the window that comes
// up after the update loads an unpatched bundle, which never requires host.js, so nothing of
// Claudapter is alive to notice. This extension is the part that survives: VS Code never replaces it,
// it activates on every window, and its only job is to run the patcher when the bundle beside it is
// clean.
//
// It holds no knowledge of the signatures. `apply-patch.mjs --if-needed` finds the newest active
// extension folder, decides whether it needs patching and reports back on one line — the same call the
// in-session watcher in host.js makes, so the two can never disagree about what "needs patching" means.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { execFile } = require('child_process');

const RUNTIME = path.join(os.homedir(), '.claude', 'claudapter');
const PATCHER = path.join(RUNTIME, 'apply-patch.mjs');
const LOG_FILE = path.join(RUNTIME, 'keeper.log');

function log(text) {
    try {
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8');
    } catch {}
}

// process.execPath is Code.exe in the extension host; ELECTRON_RUN_AS_NODE turns it back into node,
// which is what keeps this working on a machine with no node on PATH.
function runPatcher(args) {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [PATCHER, ...args],
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
            (error, stdout, stderr) => {
                const out = `${stdout || ''}${stderr || ''}`.trim();
                log(`${args.join(' ')} → ${error ? 'FAILED' : 'ok'}\n${out}`);
                if (error) return resolve({ ok: false, out });
                resolve({ ok: true, out, patched: /^ccx-result: patched$/m.test(out) });
            },
        );
    });
}

function offerReload(message) {
    vscode.window.showInformationMessage(message, 'Reload Window').then((choice) => {
        if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
}

// Matching signatures are not a promise that the code around them still means the same thing — most of
// them match the *shape* of an assignment, and a release can move what is being assigned without moving
// the shape. A hand-run patch prints the version mismatch for someone who is reading; this one has no
// reader, so the notification is the only place it can surface.
// The patcher answers "is there a release that knows this extension" on its last line; `covers` is the
// only answer worth acting on, and it turns "the patch broke" into "pull and re-run the installer"
function upstreamCovers(out) {
    const [, published, standing] = out.match(/^ccx-upstream: (\S+) (\S+)$/m) || [];
    return standing === 'covers' ? published : null;
}

function repositoryUrl() {
    try {
        const { repository } = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'patch-version.json'), 'utf8'));
        return typeof repository === 'string' ? repository.replace(/^git\+/, '').replace(/\.git$/, '') : null;
    } catch {
        return null;
    }
}

function reloadMessage(out) {
    const [, installed, verified] = out.match(/^ccx-unverified: (\S+) (\S+)$/m) || [];
    if (!installed) return 'Claudapter: Claude Code was updated — the patch has been re-applied.';
    const published = upstreamCovers(out);
    if (published)
        return (
            `Claudapter: the patch was re-applied on Claude Code ${installed}, verified only against ` +
            `${verified}. It went on cleanly, and Claudapter ${published} is published — pull it for ` +
            'signatures that were checked against this release.'
        );
    return (
        `Claudapter: the patch was re-applied on Claude Code ${installed}, which is newer than the ` +
        `${verified} it was verified against. It went on cleanly, but nothing has checked this version.`
    );
}

function reportFailure(out) {
    // The patcher stops before writing when a signature no longer matches, so a failure here means the
    // extension is intact and unpatched — Claude Code works, Claudapter is simply off until the
    // signatures are updated. This copy of the patcher cannot update itself, so the one thing worth
    // saying is whether the fix is already published.
    const version = (out.match(/anthropic\.claude-code-(\d+\.\d+\.\d+)/) || [])[1] || 'as installed';
    const published = upstreamCovers(out);
    const repository = repositoryUrl();
    const message = published
        ? `Claudapter: the patch does not fit Claude Code ${version}, but Claudapter ${published} is ` +
          'published. Pull it and re-run "node scripts/install.mjs".'
        : `Claudapter: the patch does not fit Claude Code ${version} — its signatures moved, so it was ` +
          'not applied. Claude Code itself is untouched and working.';

    vscode.window
        .showWarningMessage(message, ...(repository ? ['Open repository'] : []), 'Show log')
        .then((choice) => {
            if (choice === 'Open repository') vscode.env.openExternal(vscode.Uri.parse(repository));
            if (choice === 'Show log') vscode.window.showTextDocument(vscode.Uri.file(LOG_FILE));
        });
}

async function sync({ explicit }) {
    if (!fs.existsSync(PATCHER)) {
        if (explicit)
            vscode.window.showWarningMessage(
                `Claudapter: the runtime is not installed — no patcher at ${PATCHER}. Run "node scripts/install.mjs" in the repository.`,
            );
        return;
    }

    const result = await runPatcher(explicit ? [] : ['--if-needed']);
    if (!result.ok) return reportFailure(result.out);

    if (explicit) return offerReload(result.patched ? reloadMessage(result.out) : 'Claudapter: patch applied.');
    if (result.patched) offerReload(reloadMessage(result.out));
}

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('claudapter.applyPatch', () => sync({ explicit: true })),
    );
    sync({ explicit: false });
}

function deactivate() {}

module.exports = { activate, deactivate };
