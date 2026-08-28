// Minimal .vsix writer. A .vsix is an OPC package — a plain ZIP with a manifest and a content-types
// map beside the extension folder — so building one needs a ZIP writer and nothing else. vsce would
// pull a dependency tree into a project that has none; deflateRaw and the CRC-32 already used for
// PNGs cover the whole format.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './png.mjs';

// 1980-01-01, the DOS epoch: a fixed stamp keeps the archive byte-identical between builds
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function localHeader(entry) {
    const name = Buffer.from(entry.name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0, 6); // flags
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(entry.crc, 14);
    head.writeUInt32LE(entry.deflated.length, 18);
    head.writeUInt32LE(entry.raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28); // extra
    return Buffer.concat([head, name]);
}

function centralHeader(entry) {
    const name = Buffer.from(entry.name, 'utf8');
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0, 8); // flags
    head.writeUInt16LE(8, 10); // deflate
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(entry.crc, 16);
    head.writeUInt32LE(entry.deflated.length, 20);
    head.writeUInt32LE(entry.raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk number
    head.writeUInt16LE(0, 36); // internal attrs
    head.writeUInt32LE(0, 38); // external attrs
    head.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([head, name]);
}

// files: [{ name, data }] — name is the path inside the archive, always with forward slashes
export function zip(files) {
    const entries = [];
    const chunks = [];
    let offset = 0;

    for (const file of files) {
        const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
        const entry = { name: file.name, raw, deflated: deflateRawSync(raw, { level: 9 }), crc: crc32(raw), offset };
        const head = localHeader(entry);
        chunks.push(head, entry.deflated);
        offset += head.length + entry.deflated.length;
        entries.push(entry);
    }

    const central = entries.map(centralHeader);
    const centralSize = central.reduce((n, b) => n + b.length, 0);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20); // comment

    return Buffer.concat([...chunks, ...central, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`;

function xmlEscape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function manifest({ name, publisher, version, displayName, description }) {
    return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(name)}" Version="${xmlEscape(version)}" Publisher="${xmlEscape(publisher)}" />
    <DisplayName>${xmlEscape(displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(description)}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

// files: [{ name, data }] relative to the extension root; package.json must be among them
export function buildVsix(pkg, files) {
    return zip([
        { name: 'extension.vsixmanifest', data: manifest(pkg) },
        { name: '[Content_Types].xml', data: CONTENT_TYPES },
        ...files.map((f) => ({ name: `extension/${f.name}`, data: f.data })),
    ]);
}
