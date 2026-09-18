// The page does not merge ccx:state — it rebuilds `state` field by field from a literal, so anything
// the host sends that the literal does not name is dropped on the very next push. That is silent: the
// host is correct, the message is correct, the field simply never lands, and the feature reading it is
// just quietly off. It cost a round of "why is the row missing" for selfUpdateRepo.
//
// So the contract is: every key stateFor() puts on the wire is read somewhere in the ccx:state handler,
// either into the rebuilt state or by one of the adopt* helpers beside it. Source-level on purpose —
// webview.js is a browser bundle around a DOM, and standing one up would test the harness, not this.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = readFileSync(path.join(ROOT, 'src', 'host.js'), 'utf8');
const page = readFileSync(path.join(ROOT, 'src', 'webview.js'), 'utf8');

function slice(source, from, to, what) {
    const start = source.indexOf(from);
    assert.notEqual(start, -1, `${what}: could not find ${JSON.stringify(from)}`);
    const end = source.indexOf(to, start);
    assert.notEqual(end, -1, `${what}: could not find ${JSON.stringify(to)} after it`);
    return source.slice(start, end);
}

// The object stateFor returns, at its own indentation — nested objects sit deeper and are not keys here
const stateForBody = slice(host, 'function stateFor(', '\n}\n', 'stateFor in host.js');
const sent = [...stateForBody.matchAll(/^ {8}([a-zA-Z][\w]*)\s*[:,]/gm)].map((m) => m[1]);

assert.ok(sent.length >= 10, `only ${sent.length} keys found in stateFor — the shape moved, fix this test`);
assert.ok(sent.includes('selfUpdateRepo'), 'stateFor no longer sends selfUpdateRepo');

const handler = slice(page, "if (d.type === 'ccx:state')", 'syncChip();', 'the ccx:state handler in webview.js');

const dropped = sent.filter((key) => !new RegExp(`\\bd\\.${key}\\b`).test(handler));
assert.deepEqual(
    dropped,
    [],
    `the host sends ${dropped.length} field(s) the page never reads, so they vanish on every ccx:state: ` +
        `${dropped.join(', ')} — add them to the rebuilt state literal or adopt them beside it`,
);
console.log(`OK — all ${sent.length} fields the host puts in ccx:state are read by the page`);

// The two that carry the self-update switch specifically: one drives the tick, the other decides
// whether the row exists at all, and a row that is never drawn looks exactly like a feature that is off
for (const key of ['selfUpdate', 'selfUpdateRepo'])
    assert.match(
        handler,
        new RegExp(`${key}: d\\.${key}`),
        `${key} is not rebuilt into state — the command-menu switch would read undefined`,
    );
console.log('OK — the self-update switch survives a state push in both of its fields');
