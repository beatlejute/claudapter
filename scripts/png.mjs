// Dependency-free PNG codec shared by the icon scripts: encode (rgbaToPng),
// decode (pngToRgba) and a box-filter downscaler (resizeRgba).
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

export function rgbaToPng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

// Reverses the per-scanline filters in place-ish. `bpp` is the byte distance to
// the pixel on the left; for sub-byte depths it is 1, so those filter against
// the previous byte rather than the previous pixel, which is what the spec says.
function unfilter(raw, height, bytesPerRow, bpp) {
    const out = Buffer.alloc(height * bytesPerRow);
    let pos = 0;
    for (let y = 0; y < height; y++) {
        const type = raw[pos++];
        const row = y * bytesPerRow;
        const prev = row - bytesPerRow;
        for (let i = 0; i < bytesPerRow; i++) {
            const x = raw[pos + i];
            const a = i >= bpp ? out[row + i - bpp] : 0;
            const b = y > 0 ? out[prev + i] : 0;
            const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0;
            let v;
            switch (type) {
                case 0: v = x; break;
                case 1: v = x + a; break;
                case 2: v = x + b; break;
                case 3: v = x + ((a + b) >> 1); break; // floor((a+b)/2), integers only
                case 4: v = x + paeth(a, b, c); break;
                default: throw Error(`PNG filter type ${type} on row ${y} is not valid`);
            }
            out[row + i] = v & 0xff;
        }
        pos += bytesPerRow;
    }
    return out;
}

function sampleAt(lines, row, index, depth) {
    if (depth === 8) return lines[row + index];
    if (depth === 16) return (lines[row + index * 2] << 8) | lines[row + index * 2 + 1];
    const bit = index * depth;
    return (lines[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

export function pngToRgba(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw Error('not a PNG file');

    let width = 0;
    let height = 0;
    let depth = 0;
    let colour = -1;
    let interlace = 0;
    let plte = null;
    let trns = null;
    const idat = [];
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        if (pos + 12 + len > buf.length) throw Error(`truncated PNG chunk ${type}`);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len; // length + type + data + CRC, so unknown chunks skip by length
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colour = data[9];
            if (data[10] !== 0) throw Error(`PNG compression method ${data[10]} is not supported`);
            if (data[11] !== 0) throw Error(`PNG filter method ${data[11]} is not supported`);
            interlace = data[12];
        } else if (type === 'PLTE') plte = Buffer.from(data);
        else if (type === 'tRNS') trns = Buffer.from(data);
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
    }

    if (colour < 0) throw Error('PNG has no IHDR chunk');
    if (!width || !height) throw Error(`PNG dimensions ${width}x${height} are not valid`);
    if (interlace !== 0) throw Error(`PNG interlace method ${interlace} (Adam7) is not supported`);
    if (!DEPTHS[colour]) throw Error(`PNG colour type ${colour} is not supported`);
    if (!DEPTHS[colour].includes(depth)) throw Error(`PNG bit depth ${depth} is not supported for colour type ${colour}`);
    if (colour === 3 && !plte) throw Error('PNG colour type 3 without a PLTE chunk');
    if (!idat.length) throw Error('PNG has no IDAT chunk');

    const channels = CHANNELS[colour];
    const bits = channels * depth;
    const bpp = Math.max(1, Math.ceil(bits / 8));
    const bytesPerRow = Math.ceil((width * bits) / 8);
    // Every IDAT is one slice of a single zlib stream, so concatenate before inflating.
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < height * (bytesPerRow + 1)) throw Error('PNG image data is truncated');
    const lines = unfilter(raw, height, bytesPerRow, bpp);

    const max = (1 << depth) - 1;
    const scale = depth === 8 ? (v) => v : depth === 16 ? (v) => v >> 8 : (v) => v * (255 / max);
    // A tRNS key is stored at the source bit depth, so compare before scaling.
    const keyGray = colour === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
    const keyRgb = colour === 2 && trns && trns.length >= 6
        ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
        : null;

    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = y * bytesPerRow;
        for (let x = 0; x < width; x++) {
            const d = (y * width + x) * 4;
            const s = x * channels;
            if (colour === 3) {
                const i = sampleAt(lines, row, s, depth);
                if (i * 3 + 2 >= plte.length) throw Error(`PNG palette index ${i} is out of range`);
                rgba[d] = plte[i * 3];
                rgba[d + 1] = plte[i * 3 + 1];
                rgba[d + 2] = plte[i * 3 + 2];
                // tRNS may be shorter than PLTE; entries past its end are fully opaque.
                rgba[d + 3] = trns && i < trns.length ? trns[i] : 255;
            } else if (colour === 0 || colour === 4) {
                const g = sampleAt(lines, row, s, depth);
                rgba[d] = rgba[d + 1] = rgba[d + 2] = scale(g);
                rgba[d + 3] = colour === 4 ? scale(sampleAt(lines, row, s + 1, depth)) : g === keyGray ? 0 : 255;
            } else {
                const r = sampleAt(lines, row, s, depth);
                const g = sampleAt(lines, row, s + 1, depth);
                const b = sampleAt(lines, row, s + 2, depth);
                rgba[d] = scale(r);
                rgba[d + 1] = scale(g);
                rgba[d + 2] = scale(b);
                rgba[d + 3] = colour === 6
                    ? scale(sampleAt(lines, row, s + 3, depth))
                    : keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2] ? 0 : 255;
            }
        }
    }
    return { width, height, rgba };
}

export function resizeRgba(src, sw, sh, dw, dh) {
    if (!sw || !sh || !dw || !dh) throw Error(`cannot resize ${sw}x${sh} to ${dw}x${dh}`);
    if (src.length < sw * sh * 4) throw Error(`source buffer is ${src.length}B, expected ${sw * sh * 4}B`);
    const out = Buffer.alloc(dw * dh * 4);
    for (let dy = 0; dy < dh; dy++) {
        const y0 = Math.floor((dy * sh) / dh);
        const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh)); // never an empty box
        for (let dx = 0; dx < dw; dx++) {
            const x0 = Math.floor((dx * sw) / dw);
            const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const s = (y * sw + x) * 4;
                    // Premultiply: averaging straight RGBA lets transparent pixels drag
                    // their (often black) colour into the mean and fringes every edge.
                    const alpha = src[s + 3];
                    r += src[s] * alpha;
                    g += src[s + 1] * alpha;
                    b += src[s + 2] * alpha;
                    a += alpha;
                    n++;
                }
            }
            if (a === 0) continue; // fully transparent box, and Buffer.alloc already zeroed it
            const d = (dy * dw + dx) * 4;
            out[d] = Math.round(r / a); // divide by the accumulated alpha to un-premultiply
            out[d + 1] = Math.round(g / a);
            out[d + 2] = Math.round(b / a);
            out[d + 3] = Math.round(a / n);
        }
    }
    return out;
}
