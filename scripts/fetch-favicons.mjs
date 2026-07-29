#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = homedir();
const PROFILES_DIR = path.join(HOME, '.claude', 'profiles');
// The icon sits next to its profile and shares the name: deepseek.json -> deepseek.png
const ICONS_DIR = PROFILES_DIR;

// Brand site rather than the API endpoint: api.* hosts usually have no favicon
const SITE_OVERRIDE = {
    'api.deepseek.com': 'deepseek.com',
    'api.z.ai': 'z.ai',
    'api.minimax.io': 'minimax.io',
    'token-plan.ap-southeast-1.maas.aliyuncs.com': 'qwen.ai',
};

function siteFor(baseUrl) {
    const host = new URL(baseUrl).hostname;
    return SITE_OVERRIDE[host] || host.replace(/^api\./, '');
}

async function get(url, accept) {
    const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0', accept },
    });
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    return res;
}

async function fromHtml(site) {
    const res = await get(`https://${site}/`, 'text/html');
    const html = await res.text();
    const links = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)].map((m) => m[0]);
    const candidates = links
        .map((tag) => {
            const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
            const sizes = (tag.match(/sizes=["'](\d+)/i) || [])[1];
            return href ? { href, size: Number(sizes || 0), png: /\.png/i.test(href) || /image\/png/i.test(tag) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.png) - Number(a.png) || b.size - a.size);
    for (const c of candidates) {
        const url = new URL(c.href, `https://${site}/`).toString();
        try {
            const icon = await get(url, 'image/*');
            const buf = Buffer.from(await icon.arrayBuffer());
            if (buf.length > 70) return { buf, url };
        } catch {}
    }
    throw Error('no icon link usable');
}

async function direct(site, file) {
    const url = `https://${site}/${file}`;
    const res = await get(url, 'image/*');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 70) throw Error('too small');
    return { buf, url };
}

function extOf(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf.slice(0, 4).toString() === '<svg' || buf.slice(0, 5).toString().startsWith('<?xml')) return 'svg';
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01) return 'ico';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    return 'bin';
}

mkdirSync(ICONS_DIR, { recursive: true });
const profiles = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));

for (const file of profiles) {
    const name = file.replace(/\.json$/, '');
    const env = (JSON.parse(readFileSync(path.join(PROFILES_DIR, file), 'utf8')).env) || {};
    if (!env.ANTHROPIC_BASE_URL) {
        console.log(`${name.padEnd(10)} — subscription, stock icon`);
        continue;
    }
    const site = siteFor(env.ANTHROPIC_BASE_URL);
    let result = null;
    for (const attempt of [
        () => fromHtml(site),
        () => direct(site, 'favicon.png'),
        () => direct(site, 'favicon.ico'),
        () => direct(site, 'apple-touch-icon.png'),
    ]) {
        try {
            result = await attempt();
            break;
        } catch {}
    }
    if (!result) {
        console.log(`${name.padEnd(10)} FAIL  ${site} — a generated badge will be used`);
        continue;
    }
    const ext = extOf(result.buf);
    const out = path.join(ICONS_DIR, `${name}.${ext}`);
    writeFileSync(out, result.buf);
    console.log(`${name.padEnd(10)} OK    ${ext.padEnd(3)} ${result.buf.length}B  ${result.url}`);
}
