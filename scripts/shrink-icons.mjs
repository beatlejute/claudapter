#!/usr/bin/env node
// Profile icons are inlined into the webview as base64 and render at 13 CSS px, so a 640x640 favicon
// carries about 1,600x the pixels it will ever show. Downscale to 32 px on the long side (2x displays)
// and rewrite in place. A file that cannot be decoded is left exactly as it was.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pngToRgba, rgbaToPng, resizeRgba } from './png.mjs';

const PROFILES_DIR = path.join(homedir(), '.claude', 'profiles');
const MAX_EDGE = 32;

function base64Length(bytes) {
    return Math.ceil(bytes / 3) * 4;
}

function shrink(file) {
    const original = readFileSync(file);
    const { width, height, rgba } = pngToRgba(original);
    if (Math.max(width, height) <= MAX_EDGE) return { skipped: 'already small', width, height, bytes: original.length };

    // Fit the long side; the row paints with background-size:contain, so squashing here would be visible
    const scale = MAX_EDGE / Math.max(width, height);
    const dw = Math.max(1, Math.round(width * scale));
    const dh = Math.max(1, Math.round(height * scale));
    const out = rgbaToPng(dw, dh, resizeRgba(rgba, width, height, dw, dh));
    if (out.length >= original.length)
        return { skipped: 'no saving', width, height, bytes: original.length };

    writeFileSync(file, out);
    return { width, height, dw, dh, was: original.length, bytes: out.length };
}

const files = readdirSync(PROFILES_DIR).filter((f) => /\.png$/i.test(f));
let total = 0;

for (const name of files) {
    const file = path.join(PROFILES_DIR, name);
    try {
        const r = shrink(file);
        total += base64Length(r.bytes);
        if (r.skipped) {
            console.log(`${name.padEnd(16)} ${`${r.width}x${r.height}`.padEnd(9)} ${r.skipped.padEnd(22)} ${r.bytes}B`);
        } else {
            const saved = Math.round((1 - r.bytes / r.was) * 100);
            console.log(
                `${name.padEnd(16)} ${`${r.width}x${r.height}`.padEnd(9)} -> ${`${r.dw}x${r.dh}`.padEnd(7)} ` +
                    `${String(r.was).padStart(6)}B -> ${String(r.bytes).padStart(5)}B  -${saved}%`,
            );
        }
    } catch (e) {
        // Anything unreadable keeps its original bytes — a broken icon is worse than a large one
        total += base64Length(statSync(file).size);
        console.log(`${name.padEnd(16)} ${'KEPT'.padEnd(9)} ${e.message}`);
    }
}

// Everything else the webview inlines: SVGs and the stock logo pass through untouched
for (const name of readdirSync(PROFILES_DIR).filter((f) => /\.svg$/i.test(f)))
    total += base64Length(statSync(path.join(PROFILES_DIR, name)).size);

console.log(`\ninlined icon payload: ~${total} bytes of base64`);
