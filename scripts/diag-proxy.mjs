#!/usr/bin/env node
// Route diagnostics for OpenAI: did the proxy actually apply?
//   npm run diag
//
// This checks the route the ADAPTER will take, not the one this shell happens to have. The two are
// not the same, and the difference has already cost one debugging session: host.js spawns the adapter
// with `{...process.env, ...proxy.json.env}`, so proxy.json wins over the environment. A stale entry
// there sends the adapter to a dead proxy while a shell with the right variables reports all clear.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

const mask = (v) => (v ? String(v).replace(/\/\/[^@]*@/, '//***@') : '(unset)');
const PROXY_JSON = path.join(homedir(), '.claude', 'claudapter', 'proxy.json');
// `--use-env-proxy` reads the proxy variables once, at startup — mutating process.env later has no
// effect on fetch. So the probes cannot run in this process: they have to be re-executed in a child
// that starts with the adapter's environment already in place. Without this the report would print
// the adapter's settings and then quietly test the shell's route, which is the very confusion the
// rewrite exists to remove.
const PROBE_FLAG = '--probe';
const isProbe = process.argv.includes(PROBE_FLAG);

function overrides() {
    if (!existsSync(PROXY_JSON)) return {};
    try {
        const cfg = JSON.parse(readFileSync(PROXY_JSON, 'utf8'));
        return cfg && typeof cfg.env === 'object' && cfg.env ? cfg.env : {};
    } catch (e) {
        console.log(`proxy.json is unreadable (${e.message}) — the adapter would ignore it too.\n`);
        return {};
    }
}

// Same precedence as host.js: the file overrides the environment.
const fromFile = overrides();
const effective = { ...process.env, ...fromFile };

const VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY'];

if (!isProbe) {
    console.log('node           ', process.version, process.execPath);
    console.log('execArgv       ', JSON.stringify(process.execArgv));
    console.log('--use-env-proxy', process.execArgv.includes('--use-env-proxy') ? 'YES' : 'NO');
    console.log('proxy.json     ', existsSync(PROXY_JSON) ? PROXY_JSON : '(absent — the environment is used as-is)');
    console.log('');

    let shadowed = false;
    for (const name of VARS) {
        const shell = process.env[name];
        const file = fromFile[name];
        const overridden = file !== undefined && String(file) !== String(shell ?? '');
        if (overridden && shell) shadowed = true;
        console.log(
            `${name.padEnd(20)} ${mask(effective[name])}` +
                (overridden ? `   <- from proxy.json${shell ? `, shell had ${mask(shell)}` : ''}` : ''),
        );
    }
    if (shadowed)
        console.log(
            '\nNOTE: proxy.json overrides this shell. The values below are what the adapter uses —\n' +
                '      a route that works in this shell can still be dead for the adapter, and vice versa.',
        );
    console.log('');

    const childEnv = { ...process.env };
    for (const name of VARS) {
        if (effective[name] === undefined) delete childEnv[name];
        else childEnv[name] = String(effective[name]);
    }
    try {
        execFileSync(process.execPath, ['--use-env-proxy', fileURLToPath(import.meta.url), PROBE_FLAG], {
            stdio: 'inherit',
            env: childEnv,
        });
    } catch (e) {
        process.exitCode = typeof e.status === 'number' ? e.status : 1;
    }
    process.exit(process.exitCode || 0);
}

const probes = [
    { label: 'auth.openai.com (sign-in)', url: 'https://auth.openai.com/oauth/token' },
    { label: 'chatgpt.com (adapter upstream)', url: 'https://chatgpt.com/backend-api/codex/responses' },
];

let failed = 0;
for (const probe of probes) {
    const started = Date.now();
    try {
        const res = await fetch(probe.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        const text = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
        console.log(`${probe.label}: HTTP ${res.status} in ${Date.now() - started}ms`);
        console.log(`  ${text}`);
        // A 403 served as HTML is Cloudflare/geo turning the request away, which means it bypassed the
        // proxy — an authenticated-looking JSON error means the route itself is fine.
        if (/unsupported_country/.test(text) || (res.status === 403 && !/^\s*[[{]/.test(text))) {
            console.log('  -> went DIRECT: the proxy did not apply.');
            failed++;
        }
    } catch (e) {
        const cause = e.cause && e.cause.message ? ` (${e.cause.message})` : '';
        console.log(`${probe.label}: FAILED in ${Date.now() - started}ms — ${e.message}${cause}`);
        console.log('  -> unreachable: wrong proxy host/port, or no route at all.');
        failed++;
    }
    console.log('');
}

if (failed) {
    console.log('VERDICT: the adapter cannot reach its upstream.');
    console.log(`  Check HTTPS_PROXY in ${PROXY_JSON} — it overrides the environment, so a stale`);
    console.log('  host or port there breaks the adapter even when this shell is configured correctly.');
    process.exitCode = 2;
} else {
    console.log('VERDICT: route works — both sign-in and the adapter upstream answered on the merits.');
}
