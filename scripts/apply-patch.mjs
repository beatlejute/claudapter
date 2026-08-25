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
        // `[w$]+` rather than `w+` — the same widening points #4 and #6–#8 already needed in the webview
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
        // signature dropped to zero hits, the same trap points #6–#8 already document. And the jsx factory
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
        file: 'webview/index.js',
        find: '["model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]',
        replace:
            '["ccx-provider","model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]/*__ccx*/',
        where: 'replace',
    },
    // --- Search sessions by content, and pinned sessions (three hooks in one component) ----------
    //
    // The stock search box only matches a row's title and git branch, both computed client-side. A
    // query the user actually typed to find a conversation is usually neither — it is something that
    // was SAID — so this adds a second, lazy pass over the transcript itself, run on the host. All
    // three anchors sit in the same component (the one rendering "Search sessions…"), captured
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
        //
        // The result then goes through pinSort, which floats the pinned sessions to the front. This is
        // the list the app renders AND the one it builds its keyboard-navigation index from, so
        // sorting it here — rather than moving rows in the DOM — keeps arrow keys agreeing with what
        // is on screen, and survives every re-render because it is part of the render.
        file: 'webview/index.js',
        find: /([\w$]+)=([\w$]+)\?([\w$]+)\.filter\(\(([\w$]+)\)=>\{let ([\w$]+)=\2\.toLowerCase\(\);return ([\w$]+)\(\4\)\.toLowerCase\(\)\.includes\(\5\)\|\|\(\4\.gitBranch\.value\?\.toLowerCase\(\)\.includes\(\5\)\?\?!1\)\}\):\3/,
        replace: (_found, result, query, source, item, lowerQ, titleFn) =>
            `${result}=(globalThis.__ccxSearchCandidates=${source},` +
            `((ccxL)=>globalThis.__ccx&&globalThis.__ccx.pinSort?globalThis.__ccx.pinSort(ccxL,ccxPinnedIds):ccxL)(` +
            `${query}?${source}.filter((${item})=>{` +
            `let ${lowerQ}=${query}.toLowerCase();return ${titleFn}(${item}).toLowerCase().includes(${lowerQ})||` +
            `(${item}.gitBranch.value?.toLowerCase().includes(${lowerQ})??!1)||` +
            `(ccxContentMatches?ccxContentMatches.has(${item}.sessionId.value):!1)}):${source}))`,
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
