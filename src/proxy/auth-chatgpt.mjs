// ChatGPT OAuth (Plus/Pro subscription): PKCE login, refresh and reuse of Codex CLI tokens.
// Tokens live in ~/.claude/claudapter/chatgpt-auth.json; if ~/.codex/auth.json exists, it is used as a source.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
// The official Codex CLI also requests api.connectors.*; narrow it down via CCX_OAUTH_SCOPE.
const SCOPE =
    process.env.CCX_OAUTH_SCOPE || 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const ORIGINATOR = process.env.CCX_OAUTH_ORIGINATOR || 'codex_cli_rs';

const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;

const RUNTIME = path.join(os.homedir(), '.claude', 'claudapter');
const STORE = path.join(RUNTIME, 'chatgpt-auth.json');
const CODEX_AUTH = path.join(os.homedir(), '.codex', 'auth.json');

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce() {
    const verifier = base64url(randomBytes(64));
    return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

function decodeJwt(token) {
    try {
        return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    } catch {
        return {};
    }
}

function accountIdFrom(tokens) {
    if (tokens.account_id) return tokens.account_id;
    const claims = decodeJwt(tokens.id_token || tokens.access_token);
    const auth = claims['https://api.openai.com/auth'] || {};
    return auth.chatgpt_account_id || auth.organization_id || claims.organization_id || null;
}

function readStore() {
    try {
        return JSON.parse(readFileSync(STORE, 'utf8'));
    } catch {}
    // Fallback: an already authenticated Codex CLI
    try {
        const raw = JSON.parse(readFileSync(CODEX_AUTH, 'utf8'));
        const tokens = raw.tokens || raw;
        if (tokens.access_token)
            return {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                id_token: tokens.id_token,
                account_id: accountIdFrom(tokens),
                expires_at: tokens.expires_at || 0,
                source: 'codex-cli',
            };
    } catch {}
    return null;
}

function writeStore(data) {
    mkdirSync(RUNTIME, { recursive: true });
    writeFileSync(STORE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function storeFrom(payload, previous = {}) {
    const expiresIn = Number(payload.expires_in || 0);
    return {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token || previous.refresh_token,
        id_token: payload.id_token || previous.id_token,
        account_id: accountIdFrom({ ...previous, ...payload }) || previous.account_id || null,
        expires_at: expiresIn ? Date.now() + expiresIn * 1000 : 0,
        source: 'claudapter',
    };
}

async function postForm(url, params) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw Error(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
}

async function refresh(current) {
    if (!current?.refresh_token) throw Error('no refresh_token — sign in again');
    const payload = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: current.refresh_token,
        scope: SCOPE,
    });
    const next = storeFrom(payload, current);
    writeStore(next);
    return next;
}

// Returns {accessToken, accountId}, refreshing an expired token on the way.
async function getAuth({ refreshSkewMs = 120_000 } = {}) {
    const current = readStore();
    if (!current) throw Error('no ChatGPT tokens — run: npm run login:chatgpt');
    const expired = current.expires_at && current.expires_at - refreshSkewMs < Date.now();
    const auth = expired ? await refresh(current) : current;
    return { accessToken: auth.access_token, accountId: auth.account_id };
}

function openBrowser(url) {
    // cmd /c start splits the URL on '&' — the browser would only receive the first parameter
    const command =
        process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] :
        process.platform === 'darwin' ? ['open', [url]] :
        ['xdg-open', [url]];
    try {
        spawn(command[0], command[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
}

// Interactive login: serves localhost:1455, opens the browser, exchanges the code for tokens.
async function login({ timeoutMs = 300_000 } = {}) {
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(24));
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: ORIGINATOR,
      state,
    });
    const authorizeUrl = `${AUTHORIZE_URL}?${params}`;

    const code = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                server.close();
            } catch {}
            fn(value);
        };
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            if (!url.pathname.startsWith('/auth/callback')) {
                res.writeHead(404).end();
                return;
            }
            const received = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            const returnedState = url.searchParams.get('state');

            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
                `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">${
                    received ? 'Done — close this tab and return to the terminal.' : `Sign-in failed: ${error || 'no code returned'}`
                }</body>`
            );
            if (error) return finish(reject, Error(`OAuth: ${error}`));
            if (returnedState !== state) return finish(reject, Error('OAuth: state mismatch'));
            if (!received) return finish(reject, Error('OAuth: no authorization code'));
            finish(resolve, received);
        });

        server.on('error', (e) =>
            finish(
                reject,
                Error(e.code === 'EADDRINUSE' ? `port ${CALLBACK_PORT} is busy (Codex CLI running?)` : e.message)
            )
        );
        server.listen(CALLBACK_PORT, '127.0.0.1', () => {
            console.log(`\nOpen this URL if the browser did not start automatically:\n${authorizeUrl}\n`);
            openBrowser(authorizeUrl);
        });
        timer = setTimeout(() => finish(reject, Error('timed out waiting for sign-in')), timeoutMs);
        timer.unref?.();
    });

    const payload = await postForm(TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
    });
    const stored = storeFrom(payload);
    writeStore(stored);
    return stored;
}

function status() {
    const current = readStore();
    if (!current) return { loggedIn: false };
    return {
        loggedIn: true,
        source: current.source,
        accountId: current.account_id,
        expiresAt: current.expires_at ? new Date(current.expires_at).toISOString() : 'unknown',
        expired: current.expires_at ? current.expires_at < Date.now() : false,
    };
}

export { getAuth, login, refresh, status, readStore, writeStore, accountIdFrom, STORE, CODEX_AUTH, CLIENT_ID };
