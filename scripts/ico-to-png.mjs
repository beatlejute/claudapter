#!/usr/bin/env node
// ICO -> PNG without dependencies: a PNG frame is passed through as is,
// a BMP frame is re-encoded into PNG using node zlib.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { rgbaToPng } from './png.mjs';

const ICONS_DIR = path.join(homedir(), '.claude', 'profiles');

function bmpFrameToPng(buf) {
    const headerSize = buf.readUInt32LE(0);
    const width = buf.readInt32LE(4);
    const height = buf.readInt32LE(8) / 2; // ICO stores XOR+AND masks
    const bpp = buf.readUInt16LE(14);
    if (bpp !== 32 && bpp !== 24) throw Error(`bpp ${bpp} not supported`);

    const pixelOffset = headerSize + (bpp === 32 ? 0 : 0);
    const bytesPP = bpp / 8;
    const rowSize = Math.ceil((width * bytesPP) / 4) * 4;
    const rgba = Buffer.alloc(width * height * 4);
    const andRowSize = Math.ceil(width / 32) * 4;
    const andOffset = pixelOffset + rowSize * height;

    for (let y = 0; y < height; y++) {
        const srcY = height - 1 - y;
        for (let x = 0; x < width; x++) {
            const s = pixelOffset + srcY * rowSize + x * bytesPP;
            const d = (y * width + x) * 4;
            rgba[d] = buf[s + 2];
            rgba[d + 1] = buf[s + 1];
            rgba[d + 2] = buf[s];
            let alpha = bpp === 32 ? buf[s + 3] : 255;
            if (bpp === 24 || alpha === 0) {
                const andByte = buf[andOffset + srcY * andRowSize + (x >> 3)];
                const masked = andByte !== undefined && (andByte >> (7 - (x & 7))) & 1;
                if (bpp === 24) alpha = masked ? 0 : 255;
                else if (alpha === 0 && !masked && buf[s] + buf[s + 1] + buf[s + 2] > 0) alpha = 255;
            }
            rgba[d + 3] = alpha;
        }
    }
    return rgbaToPng(width, height, rgba);
}

function convert(file) {
    const buf = readFileSync(file);
    if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw Error('not an ICO file');
    const count = buf.readUInt16LE(4);
    let best = null;
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16;
        const width = buf[e] || 256;
        const height = buf[e + 1] || 256;
        const size = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        const area = width * height;
        if (!best || area > best.area) best = { width, height, size, offset, area };
    }
    if (!best) throw Error('no frames');
    const data = buf.subarray(best.offset, best.offset + best.size);
    const isPng = data[0] === 0x89 && data[1] === 0x50;
    const png = isPng ? data : bmpFrameToPng(data);
    const out = file.replace(/\.ico$/i, '.png');
    writeFileSync(out, png);
    return { out, source: isPng ? 'png-frame' : 'bmp-frame', size: best.width + 'x' + best.height, bytes: png.length };
}

for (const name of readdirSync(ICONS_DIR).filter((f) => /\.ico$/i.test(f))) {
    const file = path.join(ICONS_DIR, name);
    try {
        const r = convert(file);
        console.log(`${name.padEnd(18)} -> ${path.basename(r.out).padEnd(18)} ${r.source} ${r.size} ${r.bytes}B`);
        unlinkSync(file);
    } catch (e) {
        console.log(`${name.padEnd(18)} FAIL ${e.message}`);
    }
}
