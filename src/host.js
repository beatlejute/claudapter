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

function defaultIcon() {
    const root = path.join(HOME, '.vscode', 'extensions');
    try {
        const dir = fs
            .readdirSync(root)
            .filter((d) => d.startsWith('anthropic.claude-code-'))
            .sort()
            .pop();
        if (!dir) return null;
        const icon = path.join(root, dir, 'resources', 'claude-logo.svg');
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
    activeSessionByPanel: new Map(),
    profileByWebview: new Map(),
    pendingProfile: null,
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

function isPlainLogo(value) {
    const uri = value && (value.fsPath || value.path || value.light?.fsPath || value.light?.path);
    return typeof uri === 'string' && /claude-logo\.svg$/i.test(uri);
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
            const brand = isPlainLogo(value) ? brandIconFor(panel) : null;
            if (!brand) return d.set.call(panel, value);
            const uri = vscode.Uri.file(brand);
            d.set.call(panel, { light: uri, dark: uri });
        },
    });
}

function decorate(panel) {
    hookIcon(panel);
    const brand = brandIconFor(panel);
    try {
        const uri = vscode.Uri.file(brand || defaultIcon());
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

function broadcast() {
    for (const panel of S.panels.keys()) decorate(panel);
    for (const w of S.webviews) {
        const sessionId = w.__ccxSessionId || null;
        post(w, { type: 'ccx:state', ...stateFor(sessionId, w) });
    }
}

function watchFile(file, onChange) {
    if (!fs.existsSync(path.dirname(file))) return;
    let timer = null;
    try {
        fs.watch(path.dirname(file), (_e, name) => {
            if (name && path.basename(file) !== name) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, 200);
        });
    } catch {}
}

function panelFor(webview) {
    for (const p of S.panels.keys()) if (p.webview === webview) return p;
    return null;
}

function noteSessionId(webview, sessionId) {
    if (!sessionId || webview.__ccxSessionId === sessionId) return;
    webview.__ccxSessionId = sessionId;
    const forTab = S.profileByWebview.get(webview);
    if (forTab) setBinding(sessionId, forTab);
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
        if (m.type === 'request' && m.request) {
            const id = m.request.sessionId;
            if (id && typeof id === 'string') noteSessionId(webview, id);
        }
        if (!m.type.startsWith('ccx:')) return;

        const sessionId = webview.__ccxSessionId || m.sessionId || null;
        if (m.type === 'ccx:get') post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
        else if (m.type === 'ccx:session') {
            webview.__ccxSessionId = m.sessionId || null;
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
                if (name) ensureProxy(name);
                const known = webview.__ccxSessionId || sessionId;
                if (known) setBinding(known, name);
                broadcast();
                dlog('ccx:apply', { name, sessionId: known || null });
                post(webview, { type: 'ccx:applied', sessionId: known || null, name });
            } catch (e) {
                vscode.window.showErrorMessage(`Provider switch failed: ${e.message}`);
            }
        }
    });

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
    if (!S.settingsWatcher) S.settingsWatcher = watchFile(SETTINGS_FILE, broadcast);
    if (!S.bindingsWatcher) S.bindingsWatcher = watchFile(BINDINGS_FILE, broadcast);
    decorate(panel);
}

module.exports = { renderScript, attachPanel, envFor };