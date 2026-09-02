#!/usr/bin/env node
import {
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    copyFileSync,
    unlinkSync,
    openSync,
    closeSync,
    statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST_REQUIRE =
    '/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","claudapter","host.js");' +
    'delete require.cache[require.resolve(__p)];';

const PATCHES = [
    {
        // Was a plain literal until 2.1.245, which renamed every local in it: the nonce (`u` → `U`), the
        // bundle's own script URI (`a` → `G`) and — the one that actually matters — the webview parameter
        // the injected call is handed (`e` → `$`). That release is also where `$`-prefixed names reached
        // extension.js at all, which is why `\w+` alone is no longer enough anywhere in this file.
        //
        // `getHtmlForWebview` is the one real name within reach, so the anchor starts there and runs to
        // the module <script> tag. The parameter and the nonce come out of the match; the whole span is
        // then re-emitted with the host's own <script> in front of that tag. The gap is lazy and the tag
        // is unique, so the four `getHtmlForWebview(` occurrences still yield exactly one match — the
        // definition, not a call site, since only the definition is followed by `{`.
        file: 'extension.js',
        find: /getHtmlForWebview\(([\w$]+)[^)]*\)\{[\s\S]*?<script nonce="\$\{([\w$]+)\}" src="\$\{[\w$]+\}" type="module"><\/script>/,
        replace: (found, webview, nonce) => {
            const tag = '<script nonce="${' + nonce + '}" src=';
            return found.replace(
                tag,
                () =>
                    '${(()=>{try{' +
                    HOST_REQUIRE +
                    `return require(__p).renderScript(${webview},${nonce})}catch(__e){return ""}})()}\n        ` +
                    tag,
            );
        },
        where: 'replace',
    },
    {
        // Same story as #3: the icon local is renamed too (2.1.220–2.1.224 `light:a,dark:a`, 2.1.226 `light:s,dark:s`).
        // Anchoring on the shape — and on the `.webview.options=` that always follows — keeps the panel variable
        // available for the call, which is the one name the injected code actually needs.
        file: 'extension.js',
        find: /([\w$]+)\.iconPath=\{light:([\w$]+),dark:\2\},(\1\.webview\.options=)/,
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
        // 2.1.245 put `$`-prefixed names into extension.js for the first time, so every class here is
        // `[w$]+` rather than `w+` — the same widening points #4 and #6–#9 already needed in the webview
        // bundle. It has not bitten this signature yet (2.1.245 is `q.env=Z;`), but it broke #1 and #2.
        //
        // The resume id is read off the options object (`resume:t`) instead of the parameter, which is renamed too.
        // The object itself goes along as the third argument: envFor clears its `resume` when no transcript exists
        // for that id, and the SDK builds `--resume=<id>` from that field after this expression has run.
        file: 'extension.js',
        find: /([\w$]+)\.pathToClaudeCodeExecutable=([\w$]+),\1\.executableArgs=([\w$]+),\1\.env=([\w$]+)(,[\w$]+\)|;)/,
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
        // all three on the same object. One match in 2.1.227–2.1.241, always `session=t, ctx=n`.
        //
        // Two things here were name-shaped rather than structural until 2.1.239. The helper calls were
        // `\w+`, and 2.1.239 renamed the claudeConfig one to `$b` — `\w` does not match `$`, so the whole
        // signature dropped to zero hits, the same trap points #6–#9 already document. And the jsx factory
        // was written into the replacement as a literal `b`; it has been `b` in every release seen so far,
        // but a rename would have produced a ReferenceError at render time rather than a patch-time error.
        // It is now captured off the `trailingComponent:` expression that follows, three literal strings
        // deep into the same registration, which is as stable an anchor as this file has.
        file: 'webview/index.js',
        find: /let ([\w$]+)=([\w$]+)\.modelSelection\.value,([\w$]+)=[\w$]+\(\2\.claudeConfig\.value\),([\w$]+)=[\w$]+\(\1,\2\.lastServedModel\.value,\3\);([\w$]+)\.commandRegistry\.registerAction\(\{id:"model",label:"Switch model…",description:"Change the AI model",trailingComponent:\4\?([\w$]+)\("span"/,
        replace: (found, _sel, session, _cfg, _label, ctx, jsx) =>
            found.replace(
                `${ctx}.commandRegistry.registerAction({id:"model"`,
                `(globalThis.__ccx&&globalThis.__ccx.onRegistry&&globalThis.__ccx.onRegistry(${ctx},${jsx},${session})),` +
                    `${ctx}.commandRegistry.registerAction({id:"model"`,
            ),
        where: 'replace',
    },
    {
        // Not a hook — a sort order. registerAction() ranks the "Model" section by this list and puts
        // anything it does not name at the end, so an entry added from the page would otherwise land
        // below Account & Usage in whatever order it happened to register. "Switch provider…" opens
        // the section; "Provider status…" sits beside the stock account panel, which is the entry it
        // reads as a companion to.
        file: 'webview/index.js',
        find: '["model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]',
        replace:
            '["ccx-provider","model","effort-level","toggle-thinking","switch-models-on-flag","ccx-health","account-usage"]/*__ccx*/',
        where: 'replace',
    },
    // --- Search sessions by content, and pinned sessions (four hooks in one component) -----------
    //
    // The stock search box only matches a row's title and git branch, both computed client-side. A
    // query the user actually typed to find a conversation is usually neither — it is something that
    // was SAID — so this adds a second, lazy pass over the transcript itself, run on the host. All
    // four anchors sit in the same component (the one rendering "Search sessions…"), captured
    // structurally because a `$`-prefixed parameter name (`$e`) needs `[\w$]+`, not `\w+`, to survive
    // the round trip; a plain `\w+` silently fails to match on this component and nowhere else.
    {
        // Right where the search query's own state is declared: adds two more state pairs — the ids
        // the host reports back for content search, and the pinned session ids — and hands both
        // setters to the page in the same expression, the same way injection point #4 hands over the
        // registry and session. Both hook aliases are captured rather than hardcoded — useState
        // (2.1.233: `ne`, 2.1.235–2.1.238: `ie`) and useRef (2.1.235: `ge`, 2.1.238: `_e`) are locals
        // like any other, and the minifier renames them at will. The useRef one was hardcoded until
        // 2.1.238 renamed it and this was the only signature to break.
        //
        // Pinning has to be state rather than a value the page reads at render time: nothing in the
        // component re-runs when a pin is toggled, so without a state write the list would keep its
        // old order until something else happened to re-render it.
        file: 'webview/index.js',
        find: /,\[([\w$]+),([\w$]+)\]=([\w$]+)\(""\),\[([\w$]+),([\w$]+)\]=\3\(null\),([\w$]+)=([\w$]+)\(new Map\)/,
        replace: (_found, query, setQuery, useState, renaming, setRenaming, refs, useRef) =>
            `,[${query},${setQuery}]=${useState}(""),[ccxContentMatches,ccxSetContentMatches]=${useState}(null),` +
            `[ccxPinnedIds,ccxSetPinnedIds]=${useState}(null),` +
            `ccxHandoff=(globalThis.__ccx&&globalThis.__ccx.onSearchState&&globalThis.__ccx.onSearchState(ccxSetContentMatches)),` +
            `ccxPinHandoff=(globalThis.__ccx&&globalThis.__ccx.onPinState&&globalThis.__ccx.onPinState(ccxSetPinnedIds)),` +
            `[${renaming},${setRenaming}]=${useState}(null),${refs}=${useRef}(new Map)`,
        where: 'replace',
    },
    {
        // The title/branch filter itself: OR in a content match, and expose the unfiltered candidate
        // list globally in the same expression — the onChange hook below needs it, and this is the one
        // place its variable name (`te`, but renamed on every release) is already in scope and captured.
        file: 'webview/index.js',
        find: /([\w$]+)=([\w$]+)\?([\w$]+)\.filter\(\(([\w$]+)\)=>\{let ([\w$]+)=\2\.toLowerCase\(\);return ([\w$]+)\(\4\)\.toLowerCase\(\)\.includes\(\5\)\|\|\(\4\.gitBranch\.value\?\.toLowerCase\(\)\.includes\(\5\)\?\?!1\)\}\):\3/,
        replace: (_found, result, query, source, item, lowerQ, titleFn) =>
            `${result}=(globalThis.__ccxSearchCandidates=${source},` +
            `${query}?${source}.filter((${item})=>{` +
            `let ${lowerQ}=${query}.toLowerCase();return ${titleFn}(${item}).toLowerCase().includes(${lowerQ})||` +
            `(${item}.gitBranch.value?.toLowerCase().includes(${lowerQ})??!1)||` +
            `(ccxContentMatches?ccxContentMatches.has(${item}.sessionId.value):!1)}):${source})`,
        where: 'replace',
    },
    {
        // pinSort orders the list by pin first and then by how alive the session is. This is the list
        // the app renders AND the one it builds its keyboard-navigation index from, so sorting it here
        // — rather than moving rows in the DOM — keeps arrow keys agreeing with what is on screen, and
        // survives every re-render because it is part of the render.
        //
        // Through 2.1.252 the sort rode along in #7's signature, spliced onto the filter's own result
        // across a 700-byte gap, because the accessor it needs was that far down the same `let` chain.
        // 2.1.257 ended that arrangement: the app no longer renders the filter's result. A memo now
        // sits between them and partitions open sessions to the front (`[...open,...rest]`, stable
        // within each half), and the grouping call takes THAT memo — so the sort has to reassign the
        // memo, not the filter. Sorting the filter's result would be discarded a line later.
        //
        // Which is convenient: the memo and the accessor are adjacent in the chain, so this is a short
        // anchor instead of a long one, and #7 goes back to being only about the filter.
        //
        // The stock partition is a coarser version of the same idea — open first, everything else
        // after, no pins and no running/idle distinction — and pinSort re-blocks its output into all
        // four ranks, so the two compose rather than fight.
        //
        // 2.1.257 also gave the accessor a fourth state, "unread", read from a second id set beside
        // the open one. Both sets are captured, so renaming either costs nothing here.
        file: 'webview/index.js',
        find: /,([\w$]+)=[\w$]+\(\(\)=>\{if\(!([\w$]+)\)return ([\w$]+);return [\w$]+\(\3,\(([\w$]+)\)=>[\w$]+\(\4\)===!0\)\},\[\3,\2,[\w$]+\]\),([\w$]+)=[\w$]+\(\(([\w$]+)\)=>\{if\(!\2&&!([\w$]+)\)return;[\s\S]{0,400}?return [\w$]+\([\w$]+\(\2\),\6\.busy\.value,\6\.pendingInput\.value,[\w$]+\(\7\)\)\},\[\2,\7\]\)/,
        replace: (found, sorted, _openIds, _filtered, _memoItem, openState) =>
            found +
            `,ccxPinSorted=(${sorted}=globalThis.__ccx&&globalThis.__ccx.pinSort` +
            `?globalThis.__ccx.pinSort(${sorted},ccxPinnedIds,${openState}):${sorted})`,
        where: 'replace',
    },
    {
        // The search input: forwards every keystroke to the host lookup, on top of the stock J(...).
        // Reads the candidate list back off globalThis rather than a captured variable name, since the
        // list is computed a different statement away from the input and re-anchoring across that span
        // would be one large, fragile match instead of two small ones.
        file: 'webview/index.js',
        find: /onChange:\(([\w$]+)\)=>([\w$]+)\(\1\.target\.value\),placeholder:"Search sessions…"/,
        replace: (_found, param, setter) =>
            `onChange:(${param})=>{${setter}(${param}.target.value);` +
            `globalThis.__ccx&&globalThis.__ccx.onSearchQuery&&globalThis.__ccx.onSearchQuery(${param}.target.value,` +
            `(globalThis.__ccxSearchCandidates||[]).map((s)=>s.sessionId.value))},placeholder:"Search sessions…"`,
        where: 'replace',
    },
];

// Things the injected code drives without patching them. Losing one is not an error — claudapter
// fails closed, the menu item is simply absent — but it is silent, and this is the only place the
// disappearance is visible before a user notices the gesture stopped working.
//
// The retract gesture no longer depends on the stock Rewind action (it talks to the session object
// that injection point #4 already hands over), so there are currently no expectations to check.
const EXPECTATIONS = [];

const MARKER = '__ccx';

// The one line the automatic callers parse. `--if-needed` is what the keeper extension and the
// in-session watcher run, and both have to tell "nothing to do" from "the patch was just re-applied,
// this window is running the old bundle" — the second one is what earns a reload prompt.
const RESULT = {
    upToDate: 'ccx-result: up-to-date',
    patched: 'ccx-result: patched',
    // Followed by "<installed> <verified-against>" — a patch that went onto a version nobody checked
    unverified: 'ccx-unverified:',
    // Followed by "<published> <covers|behind>" — whether a release exists that knows this extension
    upstream: 'ccx-upstream:',
};

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

// Project version mirrors the extension version the signatures were verified against.
//
// install.mjs also drops this script into ~/.claude/claudapter/, where the keeper extension and the
// in-session watcher can reach it without the repository being anywhere on disk. There is no
// package.json above it there, so the installer stamps the version into a file beside it instead.
function projectMeta() {
    for (const rel of ['../package.json', './patch-version.json']) {
        try {
            const json = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
            // package.json spells the repository as { type, url }; the stamp carries the bare string
            if (json.version) return { version: json.version, repository: json.repository?.url || json.repository };
        } catch {}
    }
    return {};
}

const PROJECT = projectMeta();

function checkVersion(dir) {
    const supported = PROJECT.version || null;
    const installed = (path.basename(dir).match(/anthropic\.claude-code-(\d+\.\d+\.\d+)/) || [])[1];
    const differs = Boolean(supported && installed && installed !== supported);
    console.log(`patcher:   ${supported || 'unknown'}${differs ? ` (installed ${installed})` : ''}`);
    if (differs)
        console.log('  WARNING: versions differ. If the signatures changed, the patch will stop with an error.');
    return { supported, installed, differs };
}

// --- is there a release that knows this extension? ------------------------------------------------
//
// The patcher that runs unattended is a frozen copy: install.mjs puts it in ~/.claude/claudapter and
// nothing ever refreshes it, which is deliberate — fetching code over the network at the moment it is
// about to write into somebody else's bundle is a different trust surface entirely. So when a signature
// moves, the automation cannot heal itself, and the only useful thing it can do is say whether the fix
// already exists upstream. That is one GET of a published package.json, and nothing is ever downloaded
// or executed from it: the answer is a version number that goes into a notification.
//
// It runs only when something changed — a patch that failed, or one that went onto an unverified
// version. The quiet "already patched" path runs on every window and never touches the network.
// --no-upstream-check or CCX_NO_UPSTREAM_CHECK=1 turns it off; CCX_UPSTREAM_URL points it at a fork.
const UPSTREAM_TIMEOUT_MS = 4000;

function githubSlug(url) {
    const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    return m ? `${m[1]}/${m[2]}` : null;
}

function compareVersions(a, b) {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function upstreamUrl() {
    if (process.env.CCX_UPSTREAM_URL) return process.env.CCX_UPSTREAM_URL;
    const slug = githubSlug(PROJECT.repository);
    // main always tracks the newest extension version the signatures were verified against
    return slug ? `https://raw.githubusercontent.com/${slug}/main/package.json` : null;
}

async function upstreamLine(installed) {
    if (!installed || process.argv.includes('--no-upstream-check') || process.env.CCX_NO_UPSTREAM_CHECK) return null;
    const url = upstreamUrl();
    if (!url || typeof fetch !== 'function') return null;
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            headers: { accept: 'application/json' },
        });
        if (!response.ok) return null;
        const { version } = await response.json();
        if (!/^\d+\.\d+\.\d+$/.test(version || '')) return null;
        return `${RESULT.upstream} ${version} ${compareVersions(version, installed) >= 0 ? 'covers' : 'behind'}`;
    } catch {
        // Offline, proxied, rate-limited, renamed — none of it is worth a word to the user, who did not
        // ask for a version check and is being shown a patch result
        return null;
    }
}

function backupPath(file) {
    return file + '.ccx-orig';
}

function patchedFiles() {
    return [...new Set(PATCHES.map((p) => p.file))];
}

function filePatched(dir, rel) {
    const file = path.join(dir, rel);
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER);
}

function restore(dir) {
    let n = 0;
    for (const rel of patchedFiles()) {
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

// process.execPath is Code.exe when this runs from inside the extension host (the keeper extension and
// the in-session watcher both spawn it that way), so the syntax check has to carry the flag that turns
// it back into node — otherwise the child opens an editor window instead of parsing a file.
const NODE_ENV_OPTS = { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };

function checkSyntax(file) {
    try {
        execFileSync(process.execPath, ['--check', file], NODE_ENV_OPTS);
        return;
    } catch (cjsError) {
        const asModule = file + '.ccx-check.mjs';
        try {
            copyFileSync(file, asModule);
            execFileSync(process.execPath, ['--check', asModule], NODE_ENV_OPTS);
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
    for (const rel of patchedFiles()) console.log(`${filePatched(dir, rel) ? 'patched  ' : 'clean    '} ${rel}`);
}

// Restoring a 2.7 MB bundle from its backup and writing it back is not atomic, and the automatic
// callers can genuinely collide: VS Code restores every window at once, each one activates the keeper,
// and each keeper finds the same unpatched bundle. So the decision and the write happen together under
// one lock — the loser then re-reads a bundle that is already patched and reports it, which is why the
// "is it patched" test lives inside here rather than in front of it.
//
// Atomics.wait is the only way to sleep without going async, and going async would mean threading a
// promise through a script whose every other operation is a *Sync call.
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 30_000;

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, run) {
    const lock = path.join(dir, '.ccx.lock');
    let held = null;

    for (let waited = 0; held === null; waited += 250) {
        try {
            held = openSync(lock, 'wx');
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            // A crashed run leaves its lock behind, and nothing else would ever clear it
            const age = Date.now() - (statSync(lock).mtimeMs || 0);
            if (age > LOCK_STALE_MS || waited >= LOCK_WAIT_MS) {
                try {
                    unlinkSync(lock);
                } catch {}
                continue;
            }
            sleep(250);
        }
    }

    try {
        return run();
    } finally {
        try {
            closeSync(held);
            unlinkSync(lock);
        } catch {}
    }
}

const dir = findExtensionDir();
console.log(`extension: ${dir}`);
const versions = checkVersion(dir);
if (process.argv.includes('--revert')) restore(dir);
else if (process.argv.includes('--status')) status(dir);
else {
    let failure = null;
    let applied = false;
    try {
        withLock(dir, () => {
            if (process.argv.includes('--if-needed') && patchedFiles().every((rel) => filePatched(dir, rel)))
                return void console.log(RESULT.upToDate);
            apply(dir);
            applied = true;
            console.log(RESULT.patched);
            // Matching signatures are not a promise that the code around them still means the same
            // thing. Someone running the patcher by hand has the version line and the warning above in
            // front of them; an automatic run has nobody reading its output, so the mismatch has to
            // travel out to the notification the user does see.
            if (versions.differs) console.log(`${RESULT.unverified} ${versions.installed} ${versions.supported}`);
        });
    } catch (e) {
        failure = e;
    }

    // Outside the lock — a network call is never worth holding a lock across, and the other windows
    // waiting on it have nothing to do with this question
    if (failure || (applied && versions.differs)) {
        const line = await upstreamLine(versions.installed);
        if (line) console.log(line);
    }

    if (failure) throw failure;
    if (applied) console.log('\nDone. Reload VS Code window (Ctrl+Shift+P → Developer: Reload Window).');
}
