'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'claudapter');
const PROFILES_DIR = path.join(HOME, '.claude', 'profiles');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const ICONS_DIR = path.join(DIR, 'icons');
const BINDINGS_FILE = path.join(DIR, 'bindings.json');
const ICON_EXTENSIONS = ['png', 'svg'];
// An icon is inlined into the webview as base64 — past this size it is a mistake, not an icon
const MAX_ICON_BYTES = 512 * 1024;

// Several versions linger on disk after an update, so compare version numbers, not names
function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

// The extension flips the tab icon between these three on every rename_tab
const STOCK_LOGO = { idle: 'claude-logo.svg', done: 'claude-logo-done.svg', pending: 'claude-logo-pending.svg' };

function defaultIcon(state = 'idle') {
    const root = path.join(HOME, '.vscode', 'extensions');
    try {
        const dir = fs
            .readdirSync(root)
            .filter((d) => d.startsWith('anthropic.claude-code-'))
            .sort((a, b) => {
                const [x, y] = [versionOf(a), versionOf(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            })
            .pop();
        if (!dir) return null;
        const icon = path.join(root, dir, 'resources', STOCK_LOGO[state] || STOCK_LOGO.idle);
        return fs.existsSync(icon) ? icon : null;
    } catch {
        return null;
    }
}

const S = (globalThis.__ccxState ||= {
    webviews: new Set(),
    panels: new Map(),
    settingsWatcher: null,
    bindingsWatcher: null,
    profilesWatcher: null,
    activeSessionByPanel: new Map(),
    profileByWebview: new Map(),
    pendingProfile: null,
    badges: new Map(),
    iconUris: new Map(),
    warnedOverrides: new Set(),
});

const LOG_FILE = path.join(DIR, 'debug.log');

function dlog(...parts) {
    try {
        const line = `${new Date().toISOString()} ${parts
            .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
            .join(' ')}\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {}
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
        console.error('ccx: writeJson failed', e);
    }
}

function listProfiles() {
    try {
        return fs
            .readdirSync(PROFILES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
    } catch {
        return [];
    }
}

function profileEnv(name) {
    const p = readJson(path.join(PROFILES_DIR, name + '.json'));
    return p && typeof p.env === 'object' && p.env ? p.env : {};
}

function currentEnv() {
    const cfg = readJson(SETTINGS_FILE);
    return cfg && typeof cfg.env === 'object' && cfg.env ? cfg.env : {};
}

function modelOf(env) {
    return env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '';
}

function profileMatchesEnv(name, env) {
    const pEnv = profileEnv(name);
    if (!env.ANTHROPIC_BASE_URL) return Object.keys(pEnv).length === 0;
    return pEnv.ANTHROPIC_BASE_URL === env.ANTHROPIC_BASE_URL;
}

function loadBindings() {
    const raw = readJson(BINDINGS_FILE);
    return raw && typeof raw === 'object' ? raw : {};
}

function saveBindings(bindings) {
    writeJson(BINDINGS_FILE, bindings);
}

function getBinding(sessionId) {
    if (!sessionId) return null;
    const bindings = loadBindings();
    const v = bindings[sessionId];
    return v && listProfiles().includes(v) ? v : null;
}

function setBinding(sessionId, name) {
    if (!sessionId) return;
    const bindings = loadBindings();
    if (name === null) delete bindings[sessionId];
    else if (listProfiles().includes(name)) bindings[sessionId] = name;
    saveBindings(bindings);
}

function profileFromSettings() {
    const env = currentEnv();
    for (const name of listProfiles()) if (profileMatchesEnv(name, env)) return name;
    return null;
}

function effectiveProfile(sessionId, webview) {
    if (webview && S.profileByWebview.has(webview)) return S.profileByWebview.get(webview);
    return getBinding(sessionId) || profileFromSettings();
}

function managedKeys() {
    const keys = new Set();
    for (const n of listProfiles()) for (const k of Object.keys(profileEnv(n))) keys.add(k);
    return keys;
}

// Credentials and routing that must never cross a provider change. The union of profile keys is
// not enough: a key nobody declares is a key nobody deletes, so an ANTHROPIC_API_KEY sitting in the
// ambient environment would ride along to DeepSeek or GLM. The CLI resolves auth first-match-wins
// (ANTHROPIC_API_KEY before ANTHROPIC_AUTH_TOKEN) and rejects requests carrying both, so a leftover
// key does not just leak — it also breaks the profile's own auth.
const CREDENTIAL_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
];

// True when the profile brings its own routing or credentials, and the ambient ones must therefore go.
// Keying this on ANTHROPIC_BASE_URL alone would miss two real shapes: a profile that only overrides
// ANTHROPIC_AUTH_TOKEN (same endpoint, different account) and one that flips CLAUDE_CODE_USE_BEDROCK
// or _USE_VERTEX. In both, a leftover ANTHROPIC_API_KEY still wins — the CLI reads it first.
//
// A profile with an empty env means "the Anthropic subscription": it declares none of these, so
// nothing is stripped and it keeps inheriting exactly what the user already had.
function crossesProvider(profile) {
    const env = profileEnv(profile);
    return CREDENTIAL_KEYS.some((k) => k in env);
}

const PROXY_SCRIPT = path.join(DIR, 'proxy', 'server.mjs');

function localProxyPort(profile) {
    const url = profileEnv(profile).ANTHROPIC_BASE_URL || '';
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    return match ? Number(match[1]) : null;
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(400);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function ensureProxy(profile) {
    const port = localProxyPort(profile);
    if (!port || !fs.existsSync(PROXY_SCRIPT)) return;
    if (S.proxyStarting) return;
    if (await portIsOpen(port)) return;

    S.proxyStarting = true;
    try {
        const extraEnv = readJson(path.join(DIR, 'proxy.json'))?.env || {};
        const child = spawn(process.execPath, ['--use-env-proxy', PROXY_SCRIPT, '--port', String(port)], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.unref();
        dlog('proxy spawned', { port, profile });
    } catch (e) {
        dlog('proxy spawn failed', e.message);
    } finally {
        setTimeout(() => (S.proxyStarting = false), 3000);
    }
}

function envFor(baseEnv, resumeSessionId) {
    const profile = S.pendingProfile || getBinding(resumeSessionId);
    if (!profile) return baseEnv;
    const env = { ...baseEnv };
    for (const k of managedKeys()) delete env[k];
    if (crossesProvider(profile)) for (const k of CREDENTIAL_KEYS) delete env[k];
    Object.assign(env, profileEnv(profile));

    // Local adapter: without this the CLI routes even 127.0.0.1 through the corporate proxy and cannot connect
    if (localProxyPort(profile)) {
        const noProxy = '127.0.0.1,localhost';
        env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
        env.no_proxy = env.NO_PROXY;
    }
    dlog('envFor', { profile, session: resumeSessionId || 'new', baseUrl: profileEnv(profile).ANTHROPIC_BASE_URL });
    console.log(`ccx: spawning with profile "${profile}" (session ${resumeSessionId || 'new'})`);
    return env;
}

// The CLI layers ~/.claude/settings.json's `env` block on top of the spawn environment. Its own
// filter would strip provider keys, but only for hosts it treats as managed — the list is
// ["claude-desktop","claude-desktop-3p","local-agent"] and "claude-vscode" is not in it. So whatever
// is left in that block silently outranks the per-tab profile, which is exactly the hand-editing
// this project exists to replace. Warn instead of editing: settings.json is the user's file and
// claudapter never writes to it.
function warnSettingsOverride(profile) {
    const settings = currentEnv();
    const wanted = profileEnv(profile);
    // Coerced, because settings.json is hand-written JSON and a number or boolean there means the same
    // thing as its string form once it reaches process.env — warning about that would be pure noise.
    const conflicting = Object.keys(settings).filter((k) =>
        k in wanted ? String(settings[k]) !== String(wanted[k]) : CREDENTIAL_KEYS.includes(k),
    );
    if (!conflicting.length) return;

    const stamp = `${profile}:${conflicting.slice().sort().join(',')}`;
    if (S.warnedOverrides.has(stamp)) return;
    S.warnedOverrides.add(stamp);
    dlog('settings override', { profile, keys: conflicting });
    vscode.window.showWarningMessage(
        `~/.claude/settings.json sets ${conflicting.join(', ')}. Claude Code applies that on top of ` +
            `the spawn environment, so it overrides the "${profile}" profile in every tab. ` +
            `Remove those keys from settings.json for per-tab switching to take effect.`,
    );
}

function panelProfile(panel) {
    const sessionId = S.activeSessionByPanel.get(panel);
    return effectiveProfile(sessionId, panel.webview);
}

function modelsOf(name) {
    const env = profileEnv(name);
    return {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '',
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || '',
    };
}

function stateFor(sessionId, webview) {
    const profiles = listProfiles();
    const active = effectiveProfile(sessionId, webview);
    return {
        sessionId: sessionId || null,
        active,
        // The history list resolves each row's provider from here
        bindings: loadBindings(),
        models: active && active !== 'claude' ? modelsOf(active) : null,
        profiles: profiles.map((name) => {
            const env = profileEnv(name);
            return {
                name,
                model: modelOf(env),
                baseUrl: env.ANTHROPIC_BASE_URL || '',
            };
        }),
    };
}

// Profile icon lives next to the profile itself: ~/.claude/profiles/<name>.png|svg
function profileIconFile(name) {
    for (const ext of ICON_EXTENSIONS) {
        const file = path.join(PROFILES_DIR, `${name}.${ext}`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function hue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}

function generatedIcon(name) {
    const color = `hsl(${hue(name)} 65% 52%)`;
    const letter = name[0].toUpperCase();
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
        `<circle cx="8" cy="8" r="7" fill="${color}"/>` +
        `<text x="8" y="11.5" font-family="Segoe UI, sans-serif" font-size="9" font-weight="600" ` +
        `text-anchor="middle" fill="#fff">${letter}</text></svg>`;
    const out = path.join(ICONS_DIR, 'generated', `${name}.svg`);
    try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== svg) fs.writeFileSync(out, svg, 'utf8');
        return out;
    } catch {
        return null;
    }
}

function iconForProfile(name) {
    if (!name) return defaultIcon();
    const own = profileIconFile(name);
    if (own) return own;
    // Anthropic subscription profile (empty env) without its own icon keeps the stock logo
    if (Object.keys(profileEnv(name)).length === 0) return defaultIcon();
    return generatedIcon(name) || defaultIcon();
}

function brandIconFor(panel) {
    const profile = panelProfile(panel);
    if (!profile) return null;
    const icon = iconForProfile(profile);
    return icon && icon !== defaultIcon() ? icon : null;
}

// Which of the three stock logos the extension is trying to install, if any
function stockLogoState(value) {
    const uri = value && (value.fsPath || value.path || value.light?.fsPath || value.light?.path);
    if (typeof uri !== 'string') return null;
    const file = path.basename(uri).toLowerCase();
    for (const [state, name] of Object.entries(STOCK_LOGO)) if (file === name) return state;
    return null;
}

const BADGE_COLOR = { done: '#D97757', pending: '#3B82F6' };
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };

// A stock indicator icon is the logo with a hole punched in the corner and a dot dropped into it.
// Repeat that geometry over the profile icon, otherwise indication simply replaces the brand.
function badgedIcon(src, state) {
    const color = BADGE_COLOR[state];
    if (!color) return src;
    const cache = (S.badges ||= new Map());
    const key = `${src}|${state}`;
    try {
        const { mtimeMs, size } = fs.statSync(src);
        const hit = cache.get(key);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size && fs.existsSync(hit.out)) return hit.out;

        const ext = path.extname(src).toLowerCase();
        const data = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(src).toString('base64')}`;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em">` +
            `<defs><mask id="ccx-badge"><rect width="24" height="24" fill="white"/>` +
            `<circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs>` +
            `<image href="${data}" x="0" y="0" width="24" height="24" mask="url(#ccx-badge)"/>` +
            `<circle cx="19.5" cy="4.5" r="4.5" fill="${color}"/></svg>`;
        const out = path.join(ICONS_DIR, 'badged', `${path.basename(src, ext)}-${state}.svg`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        let current = null;
        try {
            current = fs.readFileSync(out, 'utf8');
        } catch {}
        if (current !== svg) fs.writeFileSync(out, svg, 'utf8');
        cache.set(key, { mtimeMs, size, out });
        return out;
    } catch {
        return src;
    }
}

// The webview cannot reference ~/.claude/profiles by URI — localResourceRoots covers only the
// extension's own webview/ and resources/ — so the bytes travel inside the message instead.
// The webview CSP lists data: in img-src, which is what makes this work at all.
function iconDataUri(file) {
    if (!file) return null;
    // Cached on S, not in a module const: the injected require() drops this module from the cache every call
    const cache = (S.iconUris ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        if (size > MAX_ICON_BYTES) return null;
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.uri;
        const ext = path.extname(file).toLowerCase();
        const uri = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
        cache.set(file, { mtimeMs, size, uri });
        return uri;
    } catch {
        return null;
    }
}

// { profileName: dataUri } — the same resolution order as the tab icon, without the state badge:
// the history list wants the plain brand mark, not a pending/done indicator
function profileIcons() {
    const out = {};
    for (const name of listProfiles()) {
        try {
            const uri = iconDataUri(iconForProfile(name));
            if (uri) out[name] = uri;
        } catch {}
    }
    return out;
}

function iconFor(panel, state) {
    const brand = brandIconFor(panel);
    if (brand) return badgedIcon(brand, state);
    return defaultIcon(state) || defaultIcon();
}

function hookIcon(panel) {
    if (panel.__ccxIconHooked) return;
    const proto = Object.getPrototypeOf(panel);
    const d =
        Object.getOwnPropertyDescriptor(panel, 'iconPath') || (proto && Object.getOwnPropertyDescriptor(proto, 'iconPath'));
    if (!d || !d.set || !d.get) return;
    panel.__ccxIconHooked = true;
    Object.defineProperty(panel, 'iconPath', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
            return d.get.call(panel);
        },
        set(value) {
            const state = stockLogoState(value);
            if (!state) return d.set.call(panel, value);
            // Remembered so a later decorate() re-paints the icon in the state the extension last asked for
            panel.__ccxIconState = state;
            const icon = iconFor(panel, state);
            if (!icon) return d.set.call(panel, value);
            const uri = vscode.Uri.file(icon);
            d.set.call(panel, { light: uri, dark: uri });
        },
    });
}

function decorate(panel) {
    hookIcon(panel);
    try {
        const uri = vscode.Uri.file(iconFor(panel, panel.__ccxIconState || 'idle'));
        panel.iconPath = { light: uri, dark: uri };
    } catch {}
}

function post(webview, message) {
    try {
        Promise.resolve(webview.postMessage(message)).catch(() => S.webviews.delete(webview));
    } catch {
        S.webviews.delete(webview);
    }
}

// A session with no binding ran on whatever settings.json said at the time, so the row falls back to the
// profile that matches settings.json now — for an untouched install that is the Anthropic subscription and
// the stock mark. Where settings.json points somewhere no profile describes, we genuinely do not know.
function fallbackIcon(icons) {
    const name = profileFromSettings();
    if (name) return icons[name] ? { name, uri: icons[name] } : null;
    if (currentEnv().ANTHROPIC_BASE_URL) return null;
    const uri = iconDataUri(defaultIcon());
    return uri ? { name: 'claude', uri } : null;
}

// Tens of kilobytes of base64. Sent once per webview and again only when the icon set actually
// changes — deliberately not folded into ccx:state, which is re-posted on every binding write
function postIcons(webview) {
    try {
        const icons = profileIcons();
        const fallback = fallbackIcon(icons);
        const stamp =
            Object.keys(icons)
                .map((n) => `${n}:${icons[n].length}`)
                .join(',') + `|${fallback ? `${fallback.name}:${fallback.uri.length}` : ''}`;
        if (webview.__ccxIconStamp === stamp) return;
        webview.__ccxIconStamp = stamp;
        post(webview, { type: 'ccx:icons', icons, fallback });
    } catch {}
}

function broadcast() {
    for (const panel of S.panels.keys()) decorate(panel);
    for (const w of S.webviews) {
        postIcons(w);
        const sessionId = w.__ccxSessionId || null;
        post(w, { type: 'ccx:state', ...stateFor(sessionId, w) });
    }
}

// Returns the watcher: without it the caller's `if (!S.xWatcher)` guard never latches and every
// attach installs another fs.watch on the same directory
function watchFile(file, onChange) {
    if (!fs.existsSync(path.dirname(file))) return null;
    let timer = null;
    try {
        return fs.watch(path.dirname(file), (_e, name) => {
            if (name && path.basename(file) !== name) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, 200);
        });
    } catch {
        return null;
    }
}

function watchDir(dir, onChange) {
    if (!fs.existsSync(dir)) return null;
    let timer = null;
    try {
        return fs.watch(dir, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, 200);
        });
    } catch {
        return null;
    }
}

// Installed from attachWebview, not only from attachPanel: the session list is a sidebar webview
// with no panel of its own, and it still has to see bindings.json change to repaint its icons
function ensureWatchers() {
    if (!S.settingsWatcher) S.settingsWatcher = watchFile(SETTINGS_FILE, broadcast);
    if (!S.bindingsWatcher) S.bindingsWatcher = watchFile(BINDINGS_FILE, broadcast);
    if (!S.profilesWatcher) S.profilesWatcher = watchDir(PROFILES_DIR, broadcast);
}

function panelFor(webview) {
    for (const p of S.panels.keys()) if (p.webview === webview) return p;
    return null;
}

// `weak` marks an id lifted out of a request envelope rather than out of this tab's own channel.
// Those ids are not reliably the active session, so they may only fill a gap — never overwrite an id
// the channel gave us, and never create a binding. Getting that wrong writes a profile against a
// session the user never switched, and the wrong provider then sticks to it.
function noteSessionId(webview, sessionId, weak = false) {
    if (!sessionId || webview.__ccxSessionId === sessionId) return;
    if (weak && webview.__ccxSessionId) return;
    webview.__ccxSessionId = sessionId;
    // Remembered so a later ccx:apply does not bind against an id only a weak source ever confirmed
    webview.__ccxSessionWeak = weak;
    const forTab = S.profileByWebview.get(webview);
    if (forTab && !weak) setBinding(sessionId, forTab);
    const panel = panelFor(webview);
    if (panel) {
        S.activeSessionByPanel.set(panel, sessionId);
        decorate(panel);
    }
    post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
}

function interceptOutgoing(webview) {
    if (webview.__ccxPatched) return;
    webview.__ccxPatched = true;
    const original = webview.postMessage.bind(webview);
    webview.postMessage = (msg) => {
        try {
            const envelope = msg && msg.type === 'from-extension' ? msg.message : null;
            const sdk = envelope && envelope.type === 'io_message' ? envelope.message : null;
            if (sdk && sdk.type === 'system' && sdk.subtype === 'init' && sdk.session_id)
                noteSessionId(webview, sdk.session_id);
        } catch {}
        return original(msg);
    };
}

function attachWebview(webview) {
    interceptOutgoing(webview);
    ensureWatchers();
    if (S.webviews.has(webview)) return;
    S.webviews.add(webview);

    webview.onDidReceiveMessage((m) => {
        if (!m || typeof m.type !== 'string') return;

        if (m.type === 'launch_claude') {
            if (m.resume) webview.__ccxSessionId = m.resume;
            S.pendingProfile = S.profileByWebview.get(webview) || getBinding(m.resume) || null;
            dlog('launch_claude', { channelId: m.channelId, resume: m.resume || null, profile: S.pendingProfile });
            if (S.pendingProfile) ensureProxy(S.pendingProfile);
            return;
        }
        // Only update_session_state is about the tab's own session; delete_session, rename_session and
        // open_in_editor carry the id of whichever history row the user clicked. Even this one is emitted
        // once more for the session that just STOPPED being active, so it counts as a weak source.
        if (m.type === 'request' && m.request && m.request.type === 'update_session_state') {
            const id = m.request.sessionId;
            if (id && typeof id === 'string') noteSessionId(webview, id, true);
        }
        if (!m.type.startsWith('ccx:')) return;

        const sessionId = webview.__ccxSessionId || m.sessionId || null;
        if (m.type === 'ccx:get') {
            postIcons(webview);
            post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
        } else if (m.type === 'ccx:session') {
            // The webview tracks the active channel itself, so this id is authoritative
            webview.__ccxSessionId = m.sessionId || null;
            webview.__ccxSessionWeak = false;
            const forTab = S.profileByWebview.get(webview);
            if (webview.__ccxSessionId && forTab) setBinding(webview.__ccxSessionId, forTab);
            for (const p of S.panels.keys())
                if (p.webview === webview) {
                    S.activeSessionByPanel.set(p, webview.__ccxSessionId);
                    decorate(p);
                }
            post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
        } else if (m.type === 'ccx:apply') {
            const name = m.name || null;
            try {
                S.profileByWebview.set(webview, name);
                S.pendingProfile = name;
                if (name) {
                    ensureProxy(name);
                    warnSettingsOverride(name);
                }
                // m.sessionId comes from the webview's own channel bookkeeping, so it outranks an id
                // only a weak source confirmed. With neither, the binding waits: profileByWebview is
                // already set, so noteSessionId writes it as soon as the channel reports a real id.
                //
                // A weak id is never echoed back either — the webview adopts whatever it receives here
                // as state.sessionId and resumes on it, so handing it a guess would reopen the wrong
                // conversation. Sending null leaves it on its own per-channel record, which is right.
                const known = (webview.__ccxSessionWeak ? null : webview.__ccxSessionId) || m.sessionId || null;
                if (known) setBinding(known, name);
                broadcast();
                dlog('ccx:apply', { name, sessionId: known, bound: Boolean(known) });
                post(webview, { type: 'ccx:applied', sessionId: known, name });
            } catch (e) {
                vscode.window.showErrorMessage(`Provider switch failed: ${e.message}`);
            }
        }
    });

    postIcons(webview);
    post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
}

function renderScript(webview, nonce) {
    let code;
    try {
        code = fs.readFileSync(path.join(DIR, 'webview.js'), 'utf8');
    } catch {
        return '';
    }
    attachWebview(webview);
    return `<script nonce="${nonce}">\n${code.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
}

function attachPanel(panel) {
    if (!S.panels.has(panel)) {
        S.panels.set(panel, true);
        try {
            panel.onDidDispose(() => {
                S.panels.delete(panel);
                S.activeSessionByPanel.delete(panel);
            });
        } catch {}
    }
    ensureWatchers();
    decorate(panel);
}

module.exports = { renderScript, attachPanel, envFor, profileIcons };