#!/usr/bin/env node
/**
 * Run the built pack against an in-memory graph that behaves like the app's host, and a mirror
 * served from disk.
 *
 *   node test-plugin.mjs                                   # test-fixtures/mirror: 26 real entries
 *   SANCTIONS_MIRROR=../sanctions-mirror node test-plugin.mjs   # plus the whole list
 *
 * test-fixtures/mirror is what sanctions-mirror's own build makes of its test/fixture-sdn.xml (26
 * entries cut from the 2026-11-13 list, document numbers redacted):
 *
 *   node ../sanctions-mirror/scripts/build.mjs ../sanctions-mirror/test/fixture-sdn.xml \
 *     --checked-at 2026-11-14T23:47:00Z --last-modified 2026-11-13T16:32:59Z --digest-verified \
 *     --out test-fixtures/mirror
 *
 * test-fixtures/types holds the three type definitions the pack reads and writes. When the type
 * packs are checked out beside this repository (../typepack-cryptocurrency, ../typepack-basic) the
 * fixtures are compared with them, so they cannot drift from what they stand in for.
 *
 * The host contract this stands in for, and which the assertions below check:
 *   · run() is called ONCE with the whole selection; the plugin walks it.
 *   · createNode de-duplicates by the type's identity (normalize: crypto_address folds hex and
 *     bech32 case) and merges what it is given onto a node that exists; it refuses a type no
 *     installed type pack defines, and declared values of the wrong shape.
 *   · updateNode receives a DELTA, fill-merged: blank values are dropped. [] and false are values.
 *   · createEdge on a linked pair is a relabel; updateEdge amends by id and keeps the label.
 *   · edges() hands back id, endpoints, label and a copy of `data`, as the SDK's GraphEdge declares
 *     and the app's bridge does (host-bridge.ts `toEdge`, frontend main 2026-11-16).
 *     makeHost({ edgeData: false }) stands in for an older app, whose bridge handed back id,
 *     endpoints and label only (checked 2026-11-15).
 *   · a thrown error is the only failure the host sees, and it discards what the run staged.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const bundle = await import('./dist/pack.mjs');
const pack = bundle.default;
const { AddressIndex, NameMatcher, nameScore, tokens, identityFold, MIRROR, sha256Hex, exactDate, dataPath } = bundle;
const manifest = JSON.parse(readFileSync('./plugins/sanctions.manifest.json', 'utf8'));
const ADDRESS = pack.plugins.find((p) => p.manifest.identifier === 'run.vineyard.plugins.sanctions_address_screening');
const NAMES = pack.plugins.find((p) => p.manifest.identifier === 'run.vineyard.plugins.sanctions_name_screening');

const FIXTURE_MIRROR = resolve('test-fixtures/mirror');
const FULL_MIRROR = process.env.SANCTIONS_MIRROR ? resolve(process.env.SANCTIONS_MIRROR) : null;

// The fixture's checked_at is 2026-11-14T23:47Z. Runs see "now" a day later, so the stale-mirror
// warning is off unless a step moves the clock.
const REAL_NOW = Date.now;
const NOW = Date.parse('2026-11-15T23:00:00Z');
Date.now = () => NOW;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const TYPES = {};
for (const pack of ['cryptocurrency', 'identity', 'financial']) {
    const doc = readJson(`test-fixtures/types/${pack}.json`);
    for (const t of doc.types) TYPES[`${t.category}.${t.name}`] = t;
}

// ---- host stand-in ---------------------------------------------------------------------------

/** The app's validate-node.ts, reduced to the property types these three types declare. */
function refusal(typeName, def, data, { create = false } = {}) {
    const problems = [];
    for (const [name, value] of Object.entries(data)) {
        const p = def.properties[name];
        if (!p || value == null || value === '') continue;
        if (['string', 'text', 'date', 'datetime', 'url'].includes(p.type) && typeof value !== 'string') problems.push(`${name}: not a string`);
        if (p.type === 'boolean' && typeof value !== 'boolean') problems.push(`${name}: not a boolean`);
        if (p.type === 'array' && !Array.isArray(value)) problems.push(`${name}: not an array`);
        if (p.type === 'integer' && !Number.isInteger(value)) problems.push(`${name}: not an integer`);
        if (p.type === 'enum' && !p.enum.includes(value)) problems.push(`${name} must be one of ${p.enum.join(', ')} — got ${value}`);
        if (p.validator?.regex && typeof value === 'string' && !new RegExp(p.validator.regex).test(value)) problems.push(`${name}: format`);
    }
    if (create) for (const [name, p] of Object.entries(def.properties)) if (p.optional === false && (data[name] == null || data[name] === '')) problems.push(`${name} is required and was not set`);
    return problems.length ? `${typeName}: ${problems.join('; ')}` : null;
}

function identityKey(type, data) {
    const def = TYPES[type];
    if (!def) return null;
    const fold = (k, v) => {
        const p = def.properties[k];
        if (p?.normalize === 'crypto_address') return identityFold(v);
        return p?.case_insensitive ? v.toLowerCase() : v;
    };
    const keys = def.identity_properties?.length ? def.identity_properties : [def.label_property];
    const parts = keys.map((k) => (data[k] == null ? '' : fold(k, String(data[k]))));
    return parts.some((p) => p !== '') ? `${type}\0${parts.join('\0')}` : null;
}

const RESERVED_EDGE_DATA = ['confidence', 'confidence_source', 'label_source', 'corroborated_by'];

function makeHost({ installed = Object.keys(TYPES), edgeData = true } = {}) {
    const nodes = new Map();
    const edges = [];
    const log = []; // every write, in order: { op, ... }
    let seq = 0;
    const has = (t) => installed.includes(t);
    const host = {
        nodes,
        edges,
        log,
        add(type, data) {
            const id = `n${++seq}`;
            nodes.set(id, { id, type, data: { ...data } });
            return id;
        },
        link(from, to, label, data = {}) {
            const id = `e${++seq}`;
            edges.push({ id, from_node_id: from, to_node_id: to, label, data: { ...data } });
            return id;
        },
        node: (id) => nodes.get(String(id)),
        byLabel(type, field, value) {
            return [...nodes.values()].find((n) => n.type === type && n.data[field] === value);
        },
        edgesFrom: (id) => edges.filter((e) => e.from_node_id === String(id)),
        edgesTo: (id) => edges.filter((e) => e.to_node_id === String(id)),
        graph: {
            async get(id) {
                const n = nodes.get(String(id));
                return n ? { ...n, data: structuredClone(n.data) } : null;
            },
            async list(opts) {
                return { nodes: [...nodes.values()].filter((n) => !opts?.type || n.type === opts.type).map((n) => ({ ...n, data: structuredClone(n.data) })) };
            },
            async edges() {
                return edges.map(({ data, ...e }) => (edgeData ? { ...e, data: structuredClone(data) } : { ...e }));
            },
            async createNode(d) {
                if (!has(d.type) || !TYPES[d.type]) throw new Error(`type "${d.type}" is not defined by any installed typepack. Call list_node_types and use one of the types it returns.`);
                const bad = refusal(d.type, TYPES[d.type], d.data, { create: true });
                if (bad) throw new Error(bad);
                const key = identityKey(d.type, d.data);
                const live = [...nodes.values()].find((n) => identityKey(n.type, n.data) === key);
                if (live) {
                    for (const [k, v] of Object.entries(d.data)) if (v != null && v !== '') live.data[k] = v;
                    log.push({ op: 'merge', id: live.id, data: { ...d.data } });
                    return { ...live, data: structuredClone(live.data) };
                }
                const id = `n${++seq}`;
                nodes.set(id, { id, type: d.type, data: { ...d.data } });
                log.push({ op: 'create', id, type: d.type, data: { ...d.data } });
                return { id, type: d.type, data: { ...d.data } };
            },
            async updateNode(id, data) {
                const n = nodes.get(String(id));
                if (!n) throw new Error(`no node ${id}`);
                const bad = refusal(n.type, TYPES[n.type] ?? { properties: {} }, data);
                if (bad) throw new Error(bad);
                for (const [k, v] of Object.entries(data)) if (v != null && v !== '') n.data[k] = v;
                log.push({ op: 'update', id: String(id), data: structuredClone(data) });
            },
            async createEdge(e) {
                const taken = RESERVED_EDGE_DATA.filter((k) => k in (e.data ?? {}));
                if (taken.length) throw new Error(`createEdge: ${taken.join(', ')} is set by the host`);
                if (!nodes.has(String(e.from)) || !nodes.has(String(e.to))) throw new Error('createEdge: unknown endpoint');
                const existing = edges.find((x) => x.from_node_id === String(e.from) && x.to_node_id === String(e.to));
                if (existing) {
                    log.push({ op: 'relabel', id: existing.id, from: existing.label, to: e.label });
                    existing.label = e.label;
                    Object.assign(existing.data, e.data ?? {});
                    return;
                }
                const id = `e${++seq}`;
                edges.push({ id, from_node_id: String(e.from), to_node_id: String(e.to), label: e.label, data: { ...(e.data ?? {}) } });
                log.push({ op: 'edge', id, from: String(e.from), to: String(e.to), label: e.label, data: { ...(e.data ?? {}) } });
            },
            async updateEdge(id, patch) {
                const e = edges.find((x) => x.id === String(id));
                if (!e) throw new Error(`no edge ${id}`);
                if (patch.label !== undefined) e.label = patch.label;
                Object.assign(e.data, patch.data ?? {});
                log.push({ op: 'edge-update', id: String(id), label: patch.label, data: structuredClone(patch.data ?? {}) });
            },
        },
    };
    return host;
}

/**
 * ctx.net.fetch over a mirror directory. `files` serves other bodies for some paths (null: 404), the
 * way a CDN edge serves whatever it cached; `tamper(path, text)` may change what is served.
 */
function makeNet(dir = FIXTURE_MIRROR, { tamper, status, files = {} } = {}) {
    const requests = [];
    const fetch = async (url, init) => {
        requests.push(url);
        assert.ok(url.startsWith(`${MIRROR}/`), `only the mirror is fetched: ${url}`);
        assert.equal(init?.method ?? 'GET', 'GET');
        const path = url.slice(MIRROR.length + 1);
        // raw.githubusercontent.com leaves the query out of its cache key, so a query buys nothing.
        assert.ok(!path.includes('?'), `no query string: ${url}`);
        const code = status?.(path) ?? 200;
        const file = join(dir, path);
        let found = code === 200 && existsSync(file);
        let body = found ? readFileSync(file, 'utf8') : '404: Not Found';
        if (path in files) {
            found = code === 200 && files[path] !== null;
            body = found ? files[path] : '404: Not Found';
        }
        if (tamper) body = tamper(path, body, requests.length);
        return { ok: found, status: found ? 200 : code === 200 ? 404 : code, headers: {}, text: async () => body, json: async () => JSON.parse(body) };
    };
    return { requests, fetch };
}

/** The fixture's own build, and a later one (2026-11-14) in which `drop` lines are gone. */
const FIXTURE_INDEX = readJson(join(FIXTURE_MIRROR, 'index.json'));
function laterBuild(drop) {
    const index = structuredClone(FIXTURE_INDEX);
    index.source.publish_date = '2026-11-14';
    const texts = {};
    for (const path of Object.keys(FIXTURE_INDEX.files)) {
        const lines = readFileSync(join(FIXTURE_MIRROR, path), 'utf8').replace('"as_of":"2026-11-13"', '"as_of":"2026-11-14"').split('\n');
        const text = lines.filter((l) => !(drop[path] ?? []).some((d) => l.startsWith(d))).join('\n');
        texts[path] = text;
        index.files[path] = { sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
    }
    return { index, texts, indexText: `${JSON.stringify(index, null, 2)}\n` };
}
/** What an edge serves right after the mirror commits `later`: `index` is whichever index it cached. */
function afterUpdate(later, { index }) {
    const files = { 'index.json': index === 'later' ? later.indexText : readFileSync(join(FIXTURE_MIRROR, 'index.json'), 'utf8') };
    for (const [path, text] of Object.entries(later.texts)) {
        files[path] = text; // the named files are the new build
        files[dataPath(later.index.files[path].sha256)] = text; // and so is its content path
    }
    return files; // the fixture's own content paths are still there: the previous build is kept
}

async function run(plugin, host, selection, { params = {}, net = makeNet(), signal } = {}) {
    const result = await plugin.run({
        run: { runId: 'test', projectId: 'test', pluginId: plugin.manifest.identifier, platform: 'web', grantedScopes: plugin.manifest.scopes },
        input: { selection },
        params,
        graph: host.graph,
        net: { fetch: net.fetch },
        progress: { set() {}, log() {} },
        signal,
    });
    return { ...result, requests: net.requests };
}

const crypto = (host, network, address, extra = {}) => host.add('cryptocurrency.crypto_address', { network, address, ...extra });
const person = (host, full_name, extra = {}) => host.add('identity.person', { full_name, ...extra });
const org = (host, name, extra = {}) => host.add('identity.organization', { name, ...extra });

let failures = 0;
async function step(name, fn) {
    process.stdout.write(`\n▶ ${name}\n`);
    try {
        await fn();
        console.log('  ✓');
    } catch (e) {
        failures++;
        console.error(`  ✗ ${e.stack ?? e.message}`);
    }
}

// ---- 1. manifest -------------------------------------------------------------------------------
await step('the manifest is the bundle: two members, GET to the mirror only, the scopes the edge rules need', async () => {
    assert.equal(manifest.identifier, 'run.vineyard.pluginpacks.sanctions');
    assert.equal(manifest.version, pack.version);
    assert.equal(manifest.summary, pack.summary);
    assert.equal(manifest.description, pack.description);
    assert.ok(manifest.summary.length <= 250, `summary is ${manifest.summary.length} characters`);
    assert.ok(manifest.description.length <= 1500, `the page is ${manifest.description.length} characters`);
    assert.doesNotMatch(manifest.description, /type pack|review/i, 'the page says nothing about how Vineyard installs or stages');
    assert.deepEqual(manifest.platforms, { primary: 'web', web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' }, desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' } });
    assert.deepEqual(manifest.plugins.map((p) => p.identifier), ['run.vineyard.plugins.sanctions_address_screening', 'run.vineyard.plugins.sanctions_name_screening']);
    for (const m of manifest.plugins) {
        assert.ok(m.name.length <= 128 && m.description.length <= 1024, `${m.identifier}: ${m.description.length}`);
        assert.ok(!('author' in m) && !('license' in m), 'author and license are pack-level only');
        assert.deepEqual(m.scopes.graph, ['node:read', 'node:create', 'node:update', 'edge:read', 'edge:create']);
        assert.deepEqual(m.scopes.network.map((n) => [n.endpoint, n.methods]), [['https://raw.githubusercontent.com/Vineyard-Intelligence/sanctions-mirror/main', ['GET']]]);
        assert.equal(m.scopes.config, undefined, 'no key, no config');
        assert.equal(m.version, '1.0.0');
    }
    const [a, n] = manifest.plugins;
    assert.deepEqual(a.io.consumes.map((t) => `${t.typepack}/${t.category}.${t.name}`), [
        'run.vineyard.typepacks.cryptocurrency/cryptocurrency.crypto_address',
        'run.vineyard.typepacks.financial/financial.crypto_address',
    ]);
    assert.deepEqual(a.io.produces.map((t) => `${t.category}.${t.name}`), ['cryptocurrency.crypto_address', 'identity.person', 'identity.organization']);
    assert.deepEqual(n.io.consumes.map((t) => `${t.category}.${t.name}`), ['identity.person', 'identity.organization']);
    assert.deepEqual(Object.keys(n.params.properties), ['min_score', 'max_candidates', 'include_weak_aliases']);
});

await step('the type fixtures equal the type packs beside this repository', async () => {
    const real = { cryptocurrency: '../typepack-cryptocurrency/typepacks/cryptocurrency.json', identity: '../typepack-basic/typepacks/identity.json', financial: '../typepack-basic/typepacks/financial.json' };
    let compared = 0;
    for (const [name, path] of Object.entries(real)) {
        if (!existsSync(path)) continue;
        const doc = readJson(path);
        const fx = readJson(`test-fixtures/types/${name}.json`);
        assert.equal(doc.version, fx.version, `${name} is ${doc.version} beside, fixture ${fx.version}`);
        for (const t of fx.types) assert.deepEqual(doc.types.find((x) => x.name === t.name), t, `${name}.${t.name}`);
        compared++;
    }
    console.log(`      (${compared} of 3 compared with a checkout beside this one)`);
});

// ---- 2. addresses --------------------------------------------------------------------------------
await step('uid 45404: the TRON address OFAC lists as XBT is listed on tron, and its party is linked', async () => {
    const h = makeHost();
    const id = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const r = await run(ADDRESS, h, [id]);
    assert.deepEqual(
        { s: h.node(id).data.sanctioned, p: h.node(id).data.sanctions_programs, a: h.node(id).data.sanctions_as_of },
        { s: true, p: ['ILLICIT-DRUGS-EO14059'], a: '2026-11-13' },
    );
    const party = h.byLabel('identity.person', 'full_name', 'WANG, Mingming (OFAC SDN 45404)');
    assert.ok(party, 'the listed individual is a Person');
    assert.deepEqual(party.data, {
        full_name: 'WANG, Mingming (OFAC SDN 45404)',
        aliases: ['WANG, Mingming'],
        date_of_birth: '1989-03-12',
        nationality: 'China',
        listed_places_of_birth: ['Hebei, China'],
        sanctioned: true,
        sanctions_list: 'OFAC SDN',
        sanctions_uid: '45404',
        sanctions_programs: ['ILLICIT-DRUGS-EO14059'],
        sanctions_as_of: '2026-11-13',
    });
    const [edge] = h.edgesFrom(party.id);
    assert.equal(edge.to_node_id, id);
    assert.equal(edge.label, 'listed address');
    assert.deepEqual(edge.data, { list: 'OFAC SDN', uid: '45404', program: ['ILLICIT-DRUGS-EO14059'], listed_as: ['XBT'], as_of: '2026-11-13' });
    assert.equal(r.counts.listed, 1);
    assert.match(r.summary, /against the OFAC SDN list of 2026-11-13: 1 listed, 0 not listed/);
    console.log(`      → ${r.summary}`);
});

await step('the same string on bitcoin is another account: not listed, and the run says where it is', async () => {
    const h = makeHost();
    const id = crypto(h, 'bitcoin', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const r = await run(ADDRESS, h, [id]);
    assert.equal(h.node(id).data.sanctioned, false);
    assert.equal(h.node(id).data.sanctions_as_of, '2026-11-13');
    assert.equal(h.edges.length, 0);
    assert.equal(r.counts.listed_elsewhere, 1);
    assert.match(r.summary, /another account and not a hit: TUCsTq7TofT…Lm5Yzq \(bitcoin\) is listed on tron\./);
});

await step('uid 42498: an EIP-55 spelling on ethereum is listed; bsc and arbitrum are named, not counted', async () => {
    const h = makeHost();
    const id = crypto(h, 'ethereum', '0x4F47BC496083C727C5FBE3CE9CDF2B0F6496270C');
    const r = await run(ADDRESS, h, [id]);
    assert.equal(h.node(id).data.sanctioned, true);
    assert.equal(h.node(id).data.address, '0x4F47BC496083C727C5FBE3CE9CDF2B0F6496270C', 'the address is not rewritten');
    const party = h.edgesTo(id).map((e) => h.node(e.from_node_id));
    assert.deepEqual(party.map((p) => [p.type, p.data.full_name]), [['identity.person', 'SIM, Hyon Sop (OFAC SDN 42498)']]);
    assert.match(r.summary, /is listed on arbitrum, bsc\./);
});

await step('uid 33151: an entity is an Organization, and one address under XBT and USDT is one link naming both', async () => {
    const h = makeHost();
    const id = crypto(h, 'bitcoin', '1CF46Rfbp97absrs7zb7dFfZS6qBXUm9EP');
    await run(ADDRESS, h, [id]);
    const [e] = h.edgesTo(id);
    const party = h.node(e.from_node_id);
    assert.equal(party.type, 'identity.organization');
    assert.deepEqual(party.data, {
        name: 'SUEX OTC, S.R.O. (OFAC SDN 33151)',
        aliases: ['SUEX OTC, S.R.O.'],
        sanctioned: true,
        sanctions_list: 'OFAC SDN',
        sanctions_uid: '33151',
        sanctions_programs: ['CYBER2'],
        sanctions_as_of: '2026-11-13',
    }, 'a weak alias is not an alias of the node');
    assert.deepEqual(e.data.listed_as, ['USDT', 'XBT']);
});

await step('an evm address: one node per network the list names, linked by "same address on", each with its listing', async () => {
    const h = makeHost();
    const id = crypto(h, 'evm', '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c');
    const r = await run(ADDRESS, h, [id]);
    const out = h.edgesFrom(id);
    assert.deepEqual(out.map((e) => [h.node(e.to_node_id).data.network, e.label]).sort(), [
        ['arbitrum', 'same address on'],
        ['bsc', 'same address on'],
        ['ethereum', 'same address on'],
    ]);
    for (const e of out) {
        const n = h.node(e.to_node_id);
        assert.equal(n.data.sanctioned, true);
        assert.equal(n.data.address, '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c');
        assert.match(e.data.basis, /^OFAC SDN lists this address on (ethereum|bsc|arbitrum) \(as (ETH|BSC|ARB)\)$/);
        assert.equal(h.edgesTo(n.id).filter((x) => x.label === 'listed address').length, 1);
    }
    assert.equal(h.node(id).data.network, 'evm', 'the original keeps its network');
    assert.equal(h.node(id).data.sanctioned, true, 'the string is listed');
    assert.equal(r.counts.networks_settled, 3);
    assert.equal(h.log.filter((w) => w.op === 'create' && w.type === 'identity.person').length, 1, 'one party for three listings');
});

await step('a USDT 0x listing names no chain, so it is a hit on that address on any EVM network', async () => {
    const h = makeHost();
    const id = crypto(h, 'polygon', '0xFAC583C0CF07EA434052C49115A4682172AB6B4F');
    await run(ADDRESS, h, [id]);
    assert.equal(h.node(id).data.sanctioned, true);
    const [e] = h.edgesTo(id);
    assert.deepEqual(e.data.listed_as, ['USDT']);
    assert.equal(e.data.uid, '45404');
});

await step('Bitcoin Cash: a legacy spelling on the node meets the CashAddr record; a legacy Financial node gets "same as"', async () => {
    const h = makeHost();
    const bch = crypto(h, 'bitcoin_cash', '18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB');
    const old = h.add('financial.crypto_address', { address: '18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB', currency: 'other' });
    const r = await run(ADDRESS, h, [bch, old]);
    assert.equal(h.node(bch).data.sanctioned, true);
    const [same] = h.edgesFrom(old);
    assert.equal(same.label, 'same as');
    assert.deepEqual(
        { network: h.node(same.to_node_id).data.network, address: h.node(same.to_node_id).data.address },
        { network: 'bitcoin_cash', address: 'qpgf0ztxq3mwfq6eg5versgfdzq9c3pwv5jsk6wnay' },
    );
    assert.equal(h.node(old).data.sanctioned, true, 'the legacy node is marked, as an undeclared field');
    const listed = h.edges.filter((e) => e.label === 'listed address');
    assert.deepEqual(listed.map((e) => e.data.listed), [['18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB'], ['18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB']]);
    assert.equal(r.counts.listed, 2);
});

await step('a legacy Financial address whose currency names one chain is matched on that chain', async () => {
    // 18M8bJ… is listed for BCH only. Marked btc, it is a Bitcoin account: not a hit, like the same
    // string as a `bitcoin` crypto_address, and not "same as" the Bitcoin Cash node.
    const h = makeHost();
    const btc = h.add('financial.crypto_address', { address: '18M8bJWMzWHDBMxoLqjHHAffdRy4SrzkfB', currency: 'btc' });
    const r = await run(ADDRESS, h, [btc]);
    assert.deepEqual([h.node(btc).data.sanctioned, h.edges.length, r.counts.listed, r.counts.networks_settled], [false, 0, 0, 0]);
    assert.match(r.summary, /another account and not a hit: 18M8bJWMzWH…SrzkfB \(bitcoin\) is listed on bitcoin_cash\./);

    // Marked trx, and listed on tron: settled to the tron node, as before.
    const h2 = makeHost();
    const trx = h2.add('financial.crypto_address', { address: 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq', currency: 'trx' });
    const r2 = await run(ADDRESS, h2, [trx]);
    assert.equal(h2.node(trx).data.sanctioned, true);
    const [same] = h2.edgesFrom(trx);
    assert.deepEqual([same.label, h2.node(same.to_node_id).data.network], ['same as', 'tron']);
    assert.equal(r2.counts.networks_settled, 1);

    // eth, usdt, bnb and other name no single chain: the string is matched on every network.
    const h3 = makeHost();
    const eth = h3.add('financial.crypto_address', { address: '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c', currency: 'eth' });
    const r3 = await run(ADDRESS, h3, [eth]);
    assert.equal(r3.counts.networks_settled, 3);
});

await step('one address, two entries: two parties, two links', async () => {
    const h = makeHost();
    const id = crypto(h, 'litecoin', 'LeKvNdNEzgQkzVVnRdV3fAu2DSF1nLsNw6');
    await run(ADDRESS, h, [id]);
    assert.deepEqual(h.edgesTo(id).map((e) => e.data.uid).sort(), ['30518', '30520']);
});

await step('not listed is written as false; a node an earlier list marked is delisted, programmes cleared', async () => {
    const h = makeHost();
    const clean = crypto(h, 'bitcoin', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
    const was = crypto(h, 'ethereum', '0x8589427373d6d84e98730d7795d8f6f8731fda16', { sanctioned: true, sanctions_list: 'OFAC SDN', sanctions_programs: ['CYBER2'], sanctions_as_of: '2022-08-08' });
    const r = await run(ADDRESS, h, [clean, was]);
    assert.deepEqual(
        Object.fromEntries(['sanctioned', 'sanctions_list', 'sanctions_programs', 'sanctions_as_of'].map((k) => [k, h.node(was).data[k]])),
        { sanctioned: false, sanctions_list: 'OFAC SDN', sanctions_programs: [], sanctions_as_of: '2026-11-13' },
    );
    assert.deepEqual(h.log.find((w) => w.id === clean)?.data, { sanctioned: false, sanctions_list: 'OFAC SDN', sanctions_as_of: '2026-11-13' }, 'no programmes key on a node that had none');
    assert.equal(r.counts.delisted, 1);
    assert.match(r.summary, /marked sanctioned earlier is not on this list/);
});

await step('a sanctioned = true this pack did not write is left alone: OFAC not listing it does not refute another list', async () => {
    const h = makeHost();
    const uk = crypto(h, 'bitcoin', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', { sanctioned: true, sanctions_list: 'UK OFSI', sanctions_programs: ['RUSSIA'], sanctions_as_of: '2026-10-01' });
    const hand = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq', { sanctioned: true, sanctions_as_of: '2026-09-30' });
    const before = { uk: structuredClone(h.node(uk).data), hand: structuredClone(h.node(hand).data) };
    const r = await run(ADDRESS, h, [uk, hand]);
    assert.deepEqual(h.node(uk).data, before.uk, 'not on OFAC: the UK listing stays');
    assert.deepEqual(h.node(hand).data, before.hand, 'on OFAC too: the fields stay the analyst\'s');
    assert.ok(!h.log.some((w) => w.op === 'update' && (w.id === uk || w.id === hand)));
    const [e] = h.edgesTo(hand);
    assert.equal(e?.label, 'listed address', 'the OFAC listing is still drawn');
    assert.equal(e.data.uid, '45404');
    assert.deepEqual([r.counts.listed, r.counts.not_listed, r.counts.delisted, r.counts.other_source], [1, 1, 0, 2]);
    assert.match(r.summary, /2 addresses already marked sanctioned without OFAC SDN as sanctions_list \(by hand, or from another list\) were left as they are/);
    assert.doesNotMatch(r.summary, /written sanctioned = false/);
});

await step('an address node the list settles keeps another source\'s claim too: it is read before it is written', async () => {
    // The project already has the ethereum node, marked from a UK listing. Screening the evm node
    // reaches it through createNode, which merges what it is given over what is there.
    const v = '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c';
    const h = makeHost();
    const ukClaim = { sanctioned: true, sanctions_list: 'UK OFSI', sanctions_programs: ['RUSSIA'], sanctions_as_of: '2026-10-01' };
    const eth = crypto(h, 'ethereum', v, ukClaim);
    const evm = crypto(h, 'evm', v);
    const r = await run(ADDRESS, h, [evm]);
    assert.deepEqual(h.node(eth).data, { network: 'ethereum', address: v, ...ukClaim }, 'the UK claim stays');
    assert.ok(h.edgesFrom(evm).some((e) => e.to_node_id === eth && e.label === 'same address on'), 'the existing node is the one linked');
    assert.equal(h.edgesTo(eth).filter((e) => e.label === 'listed address').length, 1, 'the OFAC listing is on its link');
    for (const net of ['bsc', 'arbitrum']) {
        const n = [...h.nodes.values()].find((x) => x.data.network === net);
        assert.deepEqual([n.data.sanctioned, n.data.sanctions_list, n.data.sanctions_as_of], [true, 'OFAC SDN', '2026-11-13'], net);
    }
    assert.equal(r.counts.other_source, 1);
    assert.match(r.summary, /1 address already marked sanctioned without OFAC SDN as sanctions_list \(by hand, or from another list\) was left as it is/);

    // An earlier OFAC answer on it is this pack's own, and follows the list.
    const h2 = makeHost();
    const eth2 = crypto(h2, 'ethereum', v, { sanctioned: false, sanctions_list: 'OFAC SDN', sanctions_as_of: '2026-01-01' });
    await run(ADDRESS, h2, [crypto(h2, 'evm', v)]);
    assert.deepEqual([h2.node(eth2).data.sanctioned, h2.node(eth2).data.sanctions_as_of], [true, '2026-11-13']);
});

await step('uid 45314 lists one 0x value under ETH and, with no chain, USDC and USDT: one link carries all three codes', async () => {
    const v = '0x983a81ca6fb1e441266d2fbcb7d8e530ac2e05a2';
    const h = makeHost();
    const eth = crypto(h, 'ethereum', v);
    const r = await run(ADDRESS, h, [eth]);
    const links = h.edgesTo(eth);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].data.listed_as, ['ETH', 'USDC', 'USDT']);
    assert.deepEqual(links[0].data.listed, ['0x983a81ca6FB1e441266D2FbcB7D8E530AC2E05A2']);
    assert.equal(r.counts.parties_linked, 1, 'one link drawn, counted once');
    assert.match(r.summary, /1 new, 1 link drawn or updated/);

    // From an evm node: its own (chainless) listing, and the ethereum node the list settles gets both.
    const h2 = makeHost();
    const evm = crypto(h2, 'evm', v);
    const r2 = await run(ADDRESS, h2, [evm]);
    assert.deepEqual(h2.edgesTo(evm).map((e) => e.data.listed_as), [['USDC', 'USDT']]);
    const [same] = h2.edgesFrom(evm).filter((e) => e.label === 'same address on');
    const settled = h2.node(same.to_node_id);
    assert.equal(settled.data.network, 'ethereum');
    assert.deepEqual(h2.edgesTo(settled.id).filter((e) => e.label === 'listed address').map((e) => e.data.listed_as), [['ETH', 'USDC', 'USDT']]);
    assert.equal(r2.counts.parties_linked, 2);

    // Both selected: the ethereum node is reached twice (directly and from the evm node), linked once.
    const h3 = makeHost();
    const ids = [crypto(h3, 'ethereum', v), crypto(h3, 'evm', v)];
    const r3 = await run(ADDRESS, h3, ids);
    assert.equal(h3.edges.filter((e) => e.label === 'listed address').length, 2);
    assert.equal(r3.counts.parties_linked, 2);
});

await step('a party is found by its uid: a label the analyst edited, or a name OFAC changed, makes no second node', async () => {
    const v = '0x983a81ca6fb1e441266d2fbcb7d8e530ac2e05a2';
    const h = makeHost({ edgeData: true });
    const eth = crypto(h, 'ethereum', v);
    await run(ADDRESS, h, [eth]);
    const [party] = [...h.nodes.values()].filter((n) => n.data.sanctions_uid === '45314');
    assert.ok(party, 'the first run made the party');
    party.data.name = 'Valerian Labs (analyst wording)';
    const shard = readJson(join(FIXTURE_MIRROR, 'addresses.json'));
    const renamed = structuredClone(shard);
    renamed.parties['45314'].name = `${shard.parties['45314'].name} RENAMED`;
    renamed.parties['45314'].programs = [...shard.parties['45314'].programs, 'NEW-PROGRAM'];
    const text = `${JSON.stringify(renamed)}\n`;
    const index = structuredClone(FIXTURE_INDEX);
    index.files['addresses.json'] = { sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
    const net = makeNet(FIXTURE_MIRROR, { files: { 'index.json': JSON.stringify(index), [dataPath(sha256Hex(text))]: text } });
    const before = h.nodes.size;
    await run(ADDRESS, h, [eth], { net });
    assert.equal(h.nodes.size, before, 'no new node');
    assert.equal([...h.nodes.values()].filter((n) => n.data.sanctions_uid === '45314').length, 1);
    assert.equal(party.data.name, 'Valerian Labs (analyst wording)', 'the label stays the analyst\'s');
    assert.ok(party.data.sanctions_programs.includes('NEW-PROGRAM'), 'the sanctions fields follow the list');
    assert.equal(h.edgesTo(eth).length, 1, 'one listed address link, from the one party');
    assert.ok(h.edgesTo(eth)[0].data.program.includes('NEW-PROGRAM'));

    // Name Screening finds the party by uid too.
    const subj = org(h, 'Valerian Labs');
    await run(NAMES, h, [subj], { params: { min_score: 0.75 } });
    assert.equal([...h.nodes.values()].filter((n) => n.data.sanctions_uid === '45314').length, 1);
});

await step('a re-run on an unchanged list stages nothing, whether or not the host shows link data', async () => {
    // The app hands plugins a copy of each link's data; an older app handed edges without `data`.
    // Read as "no keys", every link looked changed and the second run staged an update for each,
    // with all of its keys.
    for (const edgeData of [false, true]) {
        const h = makeHost({ edgeData });
        const ids = [crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq'), crypto(h, 'evm', '0x4f47bc496083c727c5fbe3ce9cdf2b0f6496270c'), crypto(h, 'bitcoin', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT')];
        const first = await run(ADDRESS, h, ids);
        assert.ok(h.edges.length >= 7, `edgeData ${edgeData}: the first run draws the links`);
        assert.equal(first.counts.links_kept, 0);
        const before = h.log.length;
        const nodes = h.nodes.size;
        const r = await run(ADDRESS, h, ids);
        assert.deepEqual(h.log.slice(before).filter((w) => w.op !== 'merge'), [], `edgeData ${edgeData}: no update, no edge`);
        assert.equal(h.nodes.size, nodes, 'no new node');
        assert.equal(r.counts.updated, 0);
        assert.equal(r.counts.parties_linked, 0);
        assert.doesNotMatch(r.summary, /drawn or updated/);
        if (edgeData) {
            assert.equal(r.counts.links_kept, 0);
            assert.doesNotMatch(r.summary, /left as they are/);
        } else {
            assert.equal(r.counts.links_kept, h.edges.length, 'every existing link is kept, unread');
            assert.match(r.summary, new RegExp(`${h.edges.length} existing links were left as they are: this run was not given their data \\(an older Vineyard does not pass a link's data to plugins\\)`));
        }

        const hn = makeHost({ edgeData });
        const subj = [person(hn, 'Kim Yong Chol'), org(hn, 'Garantex')];
        await run(NAMES, hn, subj);
        assert.equal(hn.edges.length, 3);
        const bn = hn.log.length;
        await run(NAMES, hn, subj);
        assert.deepEqual(hn.log.slice(bn), [], `names, edgeData ${edgeData}: nothing staged`);
    }
});

await step('a re-run on a newer list refreshes each existing link: only the keys that changed, by id', async () => {
    // The app's host as it is now: edges() carries each link's data (the default here).
    const h = makeHost();
    const id = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    await run(ADDRESS, h, [id]);
    const [link] = h.edgesTo(id);
    assert.equal(link.data.as_of, '2026-11-13', 'the first run wrote the list date it read');
    const later = laterBuild({});
    const before = h.log.length;
    const r = await run(ADDRESS, h, [id], { net: makeNet(FIXTURE_MIRROR, { files: afterUpdate(later, { index: 'later' }) }) });
    const edgeWrites = h.log.slice(before).filter((w) => w.op.startsWith('edge') || w.op === 'relabel');
    assert.deepEqual(edgeWrites.map((w) => [w.op, w.id, w.data]), [['edge-update', link.id, { as_of: '2026-11-14' }]]);
    assert.equal(h.edgesTo(id)[0].data.as_of, '2026-11-14', 'the link now carries the newer list date');
    assert.equal(r.counts.links_kept, 0);
    assert.doesNotMatch(r.summary, /left as (it is|they are)/);
});

await step('an existing link keeps its label: the listing is added to it as data', async () => {
    const h = makeHost({ edgeData: true });
    const id = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const mine = person(h, 'WANG, Mingming (OFAC SDN 45404)', { aliases: ['Wang Mingming', 'analyst note'] });
    const e = h.link(mine, id, 'controls');
    await run(ADDRESS, h, [id]);
    const edge = h.edges.find((x) => x.id === e);
    assert.equal(edge.label, 'controls');
    assert.equal(edge.data.uid, '45404');
    assert.ok(!h.log.some((w) => w.op === 'relabel'));
    assert.deepEqual(h.node(mine).data.aliases, ['Wang Mingming', 'analyst note'], "the analyst's aliases stay");
    assert.equal(h.node(mine).data.sanctions_uid, '45404', 'only the sanctions fields follow the list');
    assert.equal(h.log.filter((w) => w.op === 'create').length, 0, 'the party is reused, not created');

    // An older app, which did not show the link's data: the link is left as it is, and the summary
    // says so.
    const h2 = makeHost({ edgeData: false });
    const id2 = crypto(h2, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const mine2 = person(h2, 'WANG, Mingming (OFAC SDN 45404)');
    const e2 = h2.link(mine2, id2, 'controls', { note: 'analyst' });
    const r2 = await run(ADDRESS, h2, [id2]);
    assert.deepEqual(h2.edges.find((x) => x.id === e2), { id: e2, from_node_id: mine2, to_node_id: id2, label: 'controls', data: { note: 'analyst' } });
    assert.ok(!h2.log.some((w) => w.op.startsWith('edge') || w.op === 'relabel'));
    assert.equal(h2.node(id2).data.sanctioned, true, 'the address is still marked');
    assert.match(r2.summary, /1 existing link was left as it is: this run was not given its data \(an older Vineyard does not pass a link's data to plugins\), so its keys were not compared with this list\./);
});

await step('without the Cryptocurrency type pack the run still finishes and says what to install', async () => {
    const h = makeHost({ installed: ['financial.crypto_address', 'identity.person', 'identity.organization'] });
    const old = h.add('financial.crypto_address', { address: 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq' });
    const r = await run(ADDRESS, h, [old]);
    assert.match(r.summary, /Install the Cryptocurrency type pack/);
    assert.equal(h.node(old).data.sanctioned, true);
});

await step('the mirror: nothing screened is sent, and every shard is read at the content path its index names', async () => {
    const h = makeHost();
    const id = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const ok = await run(ADDRESS, h, [id]);
    assert.deepEqual(ok.requests, [`${MIRROR}/index.json`, `${MIRROR}/${dataPath(FIXTURE_INDEX.files['addresses.json'].sha256)}`]);
    assert.ok(ok.requests.every((u) => !u.includes('TUCs')));

    // An edge that has not got the new commit yet: the content path is missing, and the file's
    // name serves the same bytes, which the hash accepts.
    const h2 = makeHost();
    const id2 = crypto(h2, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const lag = makeNet(FIXTURE_MIRROR, { files: { [dataPath(FIXTURE_INDEX.files['addresses.json'].sha256)]: null } });
    await run(ADDRESS, h2, [id2], { net: lag });
    assert.equal(h2.node(id2).data.sanctioned, true);
    assert.deepEqual(lag.requests.slice(-1), [`${MIRROR}/addresses.json`]);

    // Neither path has the bytes the index names: nothing is staged, and the run says to try again.
    const h3 = makeHost();
    const id3 = crypto(h3, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    const broken = makeNet(FIXTURE_MIRROR, { tamper: (path, body) => (path.endsWith('.json') && path !== 'index.json' ? body.replace('ILLICIT', 'XLLICIT') : body) });
    await assert.rejects(run(ADDRESS, h3, [id3], { net: broken }), /addresses\.json for the list of 2026-11-13 is not available as its index describes it: the mirror is probably being updated\. Run again in a few minutes/);
    assert.equal(h3.log.length, 0);
    const wrongDate = makeNet(FIXTURE_MIRROR, { files: { 'index.json': JSON.stringify({ ...FIXTURE_INDEX, source: { ...FIXTURE_INDEX.source, publish_date: '2026-11-12' } }) } });
    const h7 = makeHost();
    await assert.rejects(run(ADDRESS, h7, [crypto(h7, 'tron', 'T')], { net: wrongDate }), /probably being updated/, 'a shard of another date is refused');

    const h5 = makeHost();
    await assert.rejects(run(ADDRESS, h5, [crypto(h5, 'tron', 'T')], { net: makeNet(FIXTURE_MIRROR, { status: () => 404 }) }), /answered HTTP 404 for index\.json/);
    const h6 = makeHost();
    await assert.rejects(run(ADDRESS, h6, [crypto(h6, 'tron', 'T')], { net: makeNet(FIXTURE_MIRROR, { status: () => 503 }) }), /answered HTTP 503 for index\.json/);
    const future = makeNet(FIXTURE_MIRROR, { tamper: (path, body) => (path === 'index.json' ? body.replace('"format": 1', '"format": 2') : body) });
    const h4 = makeHost();
    await assert.rejects(run(ADDRESS, h4, [crypto(h4, 'tron', 'T')], { net: future }), /format 2.*Update the Sanctions Screening pack/);
});

await step('right after an update, whichever index the edge serves, a run screens against that one list and writes its date', async () => {
    // The 2026-11-14 build drops KIM, Jong Un and the TRON address of uid 45404. The named files are
    // already the new build; the index is the old one (cached) or the new one.
    const later = laterBuild({ 'names/individual.json': ['[20157,'], 'addresses.json': ['{"network":"tron","address":"TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq"'] });
    const kim = { full_name: 'KIM, Jong Un (OFAC SDN 20157)', sanctioned: true, sanctions_list: 'OFAC SDN', sanctions_uid: '20157', sanctions_programs: ['DPRK3'], sanctions_as_of: '2026-11-13' };
    for (const [which, asOf, kimListed] of [['earlier', '2026-11-13', true], ['later', '2026-11-14', false]]) {
        const net = makeNet(FIXTURE_MIRROR, { files: afterUpdate(later, { index: which }) });
        const h = makeHost();
        const party = person(h, kim.full_name, kim);
        const subject = org(h, 'Garantex');
        const r = await run(NAMES, h, [party, subject], { net });
        assert.equal(h.node(party).data.sanctioned, kimListed, `${which}: the party follows the list the index names`);
        assert.equal(h.node(party).data.sanctions_as_of, asOf, which);
        assert.deepEqual(h.edgesFrom(subject).map((e) => e.data.as_of), [asOf], which);
        assert.equal(h.node(subject).data.sanctions_screened_as_of, asOf, which);
        assert.match(r.summary, new RegExp(`against the OFAC SDN list of ${asOf}`), which);

        const h2 = makeHost();
        const tron = crypto(h2, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
        await run(ADDRESS, h2, [tron], { net: makeNet(FIXTURE_MIRROR, { files: afterUpdate(later, { index: which }) }) });
        assert.deepEqual([h2.node(tron).data.sanctioned, h2.node(tron).data.sanctions_as_of], [kimListed, asOf], `${which}: address`);
    }
});

await step('a mirror that has not checked OFAC for three days says so in the summary', async () => {
    const h = makeHost();
    const id = crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq');
    Date.now = () => Date.parse('2026-11-18T00:47:00Z'); // 73 hours after checked_at
    try {
        const r = await run(ADDRESS, h, [id]);
        assert.match(r.summary, /The mirror last checked OFAC's list 3 days ago \(2026-11-14T23:47:00Z\): designations since then are missing/);
    } finally {
        Date.now = () => NOW;
    }
    const h2 = makeHost();
    const fresh = await run(ADDRESS, h2, [crypto(h2, 'tron', 'T')]);
    assert.doesNotMatch(fresh.summary, /last checked/);
});

await step('an index that does not say its source matched OFAC\'s digest is named in the summary', async () => {
    const unverified = { ...FIXTURE_INDEX, source: { ...FIXTURE_INDEX.source, digest_verified: false } };
    const h = makeHost();
    const r = await run(ADDRESS, h, [crypto(h, 'tron', 'TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq')], { net: makeNet(FIXTURE_MIRROR, { files: { 'index.json': JSON.stringify(unverified) } }) });
    assert.match(r.summary, /This copy of the list was not checked against OFAC's digest when the mirror built it/);
    const h2 = makeHost();
    const r2 = await run(NAMES, h2, [person(h2, 'Kim Jong Un')], { net: makeNet(FIXTURE_MIRROR, { files: { 'index.json': JSON.stringify(unverified) } }) });
    assert.match(r2.summary, /not checked against OFAC's digest/);
    const h3 = makeHost();
    const ok = await run(ADDRESS, h3, [crypto(h3, 'tron', 'T')]);
    assert.doesNotMatch(ok.summary, /digest/);
});

await step('a selection with nothing to screen downloads nothing', async () => {
    const h = makeHost();
    const n = makeNet();
    const r = await run(ADDRESS, h, [person(h, 'x')], { net: n });
    assert.equal(n.requests.length, 0);
    assert.match(r.summary, /Nothing to screen/);
});

// ---- 3. names --------------------------------------------------------------------------------------
await step('"Kim Jong Un" in any spelling meets KIM, Jong Un as a possible match; the subject is not marked sanctioned', async () => {
    for (const spelling of ['Kim Jong Un', 'Kim Jong-un', 'Jong Un Kim', 'Kim Jongun', 'KIM JONG UN']) {
        const h = makeHost();
        const id = person(h, spelling);
        const r = await run(NAMES, h, [id]);
        const [e] = h.edgesFrom(id);
        assert.ok(e, spelling);
        assert.equal(e.label, 'possible sanctions match');
        assert.equal(h.node(e.to_node_id).data.full_name, 'KIM, Jong Un (OFAC SDN 20157)');
        assert.deepEqual(
            { ...e.data },
            { list: 'OFAC SDN', uid: '20157', score: 1, subject_name: spelling, listed_name: 'KIM, Jong Un', matched_on: 'name', program: ['DPRK3'], as_of: '2026-11-13', min_score: 0.85 },
        );
        assert.equal(h.node(id).data.sanctioned, undefined, 'a name match marks nothing');
        assert.deepEqual([h.node(id).data.sanctions_screened_as_of, h.node(id).data.sanctions_screened_min_score], ['2026-11-13', 0.85]);
        if (spelling === 'Kim Jong Un') console.log(`      → ${r.summary}`);
    }
});

await step('a subject written as one word meets a listed name of two, and the other way round', async () => {
    // nameScore already gave these 1.00; the index never handed the listed name to it.
    const rows = [
        [1, "AL QA'IDA", []],
        [2, 'HYDRA MARKET', []],
        [3, 'AL-SHABAAB', [['HARAKAT SHABAAB AL-MUJAHIDIN', 'strong']]],
        [4, 'GARANTEX EUROPE OU', [['GARANTEX', 'strong']]],
    ];
    const m = new NameMatcher(rows, 'org', false);
    const top = (name) => m.screen([name], 0.85, 3).map((c) => [c.uid, bundle.shownScore(c.score)]);
    assert.deepEqual(top('Alqaida'), [[1, 1]]);
    assert.deepEqual(top('Hydramarket'), [[2, 1]]);
    assert.deepEqual(top('HydraMarket LLC'), [[2, 1]]);
    assert.deepEqual(top('Alshabaab'), [[3, 1]]);
    assert.deepEqual(top('Al Qaida'), [[1, 1]], 'and the words as listed');
    const p = new NameMatcher([[20157, 'KIM, Jong Un', []]], 'person', false);
    assert.deepEqual(p.screen(['Kim Jongun'], 0.85, 3).map((c) => c.uid), [20157], 'a join on the subject side still reaches it');
    assert.deepEqual(p.screen(['Kimjong Un'], 0.85, 3).map((c) => c.uid), [20157]);
});

await step('legal forms and titles with doubled letters are dropped: "Garantex LLC" is GARANTEX', async () => {
    // Doubled letters used to be collapsed first, so LLC became "lc" and was kept as a word.
    assert.deepEqual(tokens('Garantex LLC', 'org'), ['garantex']);
    assert.deepEqual(tokens('OOO Garantex', 'org'), ['garantex']);
    assert.deepEqual(tokens('Acme FZLLC', 'org'), ['acme']);
    assert.deepEqual(tokens('Mullah Mohammed Omar', 'person'), ['mohamed', 'omar']);
    assert.deepEqual(tokens('LLC', 'org'), ['lc'], 'a name that is only a legal form keeps it');
    const h = makeHost();
    const g = org(h, 'Garantex LLC');
    await run(NAMES, h, [g]);
    assert.deepEqual(h.edgesFrom(g).map((e) => [e.data.uid, e.data.score]), [['36025', 1]]);
});

await step('namesakes stay two parties, and the date of birth says which one is closer', async () => {
    const h = makeHost();
    const id = person(h, 'Kim Yong Chol', { date_of_birth: '1962-02-18' });
    await run(NAMES, h, [id]);
    const got = h.edgesFrom(id).map((e) => [h.node(e.to_node_id).data.full_name, e.data.score, e.data.date_of_birth_check]).sort();
    assert.deepEqual(got, [
        ['KIM, Yong Chol (OFAC SDN 12211)', 1, 'different year'],
        ['KIM, Yong Chol (OFAC SDN 17614)', 1, 'same date'],
    ]);
    assert.deepEqual(h.node(h.edgesFrom(id).find((e) => e.data.uid === '12211').to_node_id).data.listed_dates_of_birth, ['circa 1947', 'circa 1946']);
});

await step('organisations: a strong alias matches, a weak one only when asked, and legal forms are ignored', async () => {
    const h = makeHost();
    const g = org(h, 'Garantex');
    const l = org(h, 'Lazarus Group LLC');
    const hc = org(h, 'Hidden Cobra');
    await run(NAMES, h, [g, l, hc]);
    assert.deepEqual(h.edgesFrom(g).map((e) => [e.data.uid, e.data.listed_name, e.data.matched_on]), [['36025', 'GARANTEX', 'strong alias']]);
    assert.deepEqual(h.edgesFrom(l).map((e) => e.data.uid), ['27307']);
    assert.equal(h.edgesFrom(hc).length, 0, 'weak aliases are off by default');
    const h2 = makeHost();
    const hc2 = org(h2, 'Hidden Cobra');
    await run(NAMES, h2, [hc2], { params: { include_weak_aliases: true } });
    assert.deepEqual(h2.edgesFrom(hc2).map((e) => [e.data.uid, e.data.matched_on]), [['27307', 'weak alias']]);
});

await step('a name in another script meets nothing, and the summary says to screen a romanized alias', async () => {
    const h = makeHost();
    const id = person(h, '김정은');
    const r = await run(NAMES, h, [id]);
    assert.equal(h.edges.length, 0);
    assert.match(r.summary, /not in Latin script met nothing/);
    const h2 = makeHost();
    const id2 = person(h2, '김정은', { aliases: ['Kim Jong Un'] });
    await run(NAMES, h2, [id2]);
    assert.equal(h2.edgesFrom(id2)[0]?.data.subject_name, 'Kim Jong Un', 'an alias is screened too');
});

await step('min score and max candidates are clamped; a re-run stages nothing', async () => {
    const h = makeHost();
    const id = person(h, 'Kim Yong Chol');
    await run(NAMES, h, [id], { params: { min_score: 7, max_candidates: 1 } });
    assert.equal(h.edgesFrom(id).length, 1);
    assert.equal(h.node(id).data.sanctions_screened_min_score, 1);
    const before = h.log.length;
    await run(NAMES, h, [id], { params: { min_score: 7, max_candidates: 1 } });
    assert.deepEqual(h.log.slice(before), []);
    const h2 = makeHost();
    const id2 = person(h2, 'Kim Yong Chol');
    await run(NAMES, h2, [id2], { params: { min_score: 'nonsense' } });
    assert.equal(h2.node(id2).data.sanctions_screened_min_score, 0.85);
});

await step('a listed party selected for name screening is re-checked by uid; one gone from the list is delisted', async () => {
    const h = makeHost();
    const here = person(h, 'KIM, Jong Un (OFAC SDN 20157)', { sanctioned: true, sanctions_list: 'OFAC SDN', sanctions_uid: '20157', sanctions_programs: ['DPRK'], sanctions_as_of: '2024-01-01' });
    const gone = org(h, 'TORNADO CASH (OFAC SDN 32656)', { sanctioned: true, sanctions_list: 'OFAC SDN', sanctions_uid: '32656', sanctions_programs: ['CYBER2', 'DPRK3'], sanctions_as_of: '2022-11-08' });
    const r = await run(NAMES, h, [here, gone]);
    assert.deepEqual([h.node(here).data.sanctions_programs, h.node(here).data.sanctions_as_of, h.node(here).data.sanctioned], [['DPRK3'], '2026-11-13', true]);
    assert.deepEqual([h.node(gone).data.sanctioned, h.node(gone).data.sanctions_programs], [false, []]);
    assert.equal(h.edges.length, 0, 'a party is not screened against itself');
    assert.match(r.summary, /2 listed parties re-checked by uid, 1 no longer on the list/);
});

await step('the name shard is fetched once per kind, and no name is in any request', async () => {
    const h = makeHost();
    const ids = [person(h, 'Kim Jong Un'), person(h, 'Wang Mingming'), org(h, 'Garantex')];
    const n = makeNet();
    await run(NAMES, h, ids, { net: n });
    assert.deepEqual(n.requests.sort(), [
        `${MIRROR}/${dataPath(FIXTURE_INDEX.files['names/entity.json'].sha256)}`,
        `${MIRROR}/${dataPath(FIXTURE_INDEX.files['names/individual.json'].sha256)}`,
        `${MIRROR}/index.json`,
    ].sort());
    assert.ok(n.requests.every((u) => !/kim|wang|garantex/i.test(u)));
});

await step('pure parts: dates, shown scores, the hash the mirror is checked with', async () => {
    assert.equal(exactDate('08 Jan 1984'), '1984-01-08');
    assert.equal(exactDate('circa 1979'), null);
    assert.equal(exactDate('31 Feb 1984'), null);
    assert.equal(bundle.shownScore(0.87999), 0.87, 'a score is never shown above what it is');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const idx = readJson(join(FIXTURE_MIRROR, 'index.json'));
    for (const [path, meta] of Object.entries(idx.files)) {
        assert.equal(sha256Hex(readFileSync(join(FIXTURE_MIRROR, path), 'utf8')), meta.sha256, path);
        assert.equal(readFileSync(join(FIXTURE_MIRROR, dataPath(meta.sha256)), 'utf8'), readFileSync(join(FIXTURE_MIRROR, path), 'utf8'), `${path} at its content path`);
    }
});

// ---- 4. the whole list ----------------------------------------------------------------------------
await step('the whole list (SANCTIONS_MIRROR)', async () => {
    if (!FULL_MIRROR) {
        console.log('      (SANCTIONS_MIRROR not set: run with SANCTIONS_MIRROR=../sanctions-mirror to check against the whole list)');
        return;
    }
    const idx = readJson(join(FULL_MIRROR, 'index.json'));
    const shard = readJson(join(FULL_MIRROR, 'addresses.json'));
    for (const [path, meta] of Object.entries(idx.files)) {
        assert.equal(sha256Hex(readFileSync(join(FULL_MIRROR, path), 'utf8')), meta.sha256, path);
        assert.equal(sha256Hex(readFileSync(join(FULL_MIRROR, dataPath(meta.sha256)), 'utf8')), meta.sha256, `${path} at its content path`);
    }
    console.log(`      OFAC SDN ${idx.source.publish_date}: ${idx.counts.addresses} addresses, ${idx.counts.entries} entries`);

    // Every record meets itself, and every value as OFAC wrote it meets its record.
    const index = new AddressIndex(shard);
    let checked = 0;
    for (const rec of shard.addresses) {
        assert.ok(index.match(rec.network, rec.address).listed.includes(rec), `${rec.network} ${rec.address}`);
        for (const l of rec.listings) if (l.listed && !l.note) assert.ok(index.match(rec.network, l.listed).listed.includes(rec), `${rec.network} ${l.listed}`);
        checked++;
    }
    // The proposal's counts, from the listings: USDT 79 TRON + 8 EVM + 7 Bitcoin; 71 of 137 EVM values checksummed.
    const listings = shard.addresses.flatMap((r) => r.listings.map((l) => ({ ...l, network: r.network, address: r.address })));
    const usdt = listings.filter((l) => l.code === 'USDT');
    const by = (xs) => xs.reduce((m, l) => ((m[l.network] = (m[l.network] ?? 0) + 1), m), {});
    console.log(`      USDT listings by network: ${JSON.stringify(by(usdt))}`);
    const evm = listings.filter((l) => /^0x/.test(l.address));
    console.log(`      EVM listings ${evm.length}, written from an EIP-55 spelling ${evm.filter((l) => l.listed).length}`);

    // The whole address list through the plugin: each one listed, nothing refused.
    const h = makeHost();
    const ids = shard.addresses.filter((r) => r.network !== 'unknown').map((r) => crypto(h, r.network, r.listings[0].listed ?? r.address));
    const t0 = REAL_NOW();
    const r = await run(ADDRESS, h, ids, { net: makeNet(FULL_MIRROR) });
    console.log(`      ${ids.length} addresses screened in ${REAL_NOW() - t0} ms: ${r.counts.listed} listed, ${r.counts.parties_created} parties, ${r.counts.refused} refused`);
    assert.equal(r.counts.listed, ids.length);
    assert.equal(r.counts.refused, 0);

    // The scores names.ts quotes.
    const ind = readJson(join(FULL_MIRROR, 'names/individual.json')).entries;
    const m = new NameMatcher(ind, 'person', false);
    const s = (a, b) => Math.round(nameScore(tokens(a, 'person'), tokens(b, 'person')) * 100) / 100;
    assert.equal(s('Kim Jong Un', 'KIM, Jong Man'), 0.73);
    assert.equal(s('Park Jin Hyok', 'RI, Jin Hyok'), 0.61);
    assert.equal(s('Kim', 'KIM, Ki Nam'), 0.38);
    assert.equal(s('Viktor Bout', 'BOUT, Viktor Anatolijevitch'), 0.88);
    assert.deepEqual(m.screen(['Kim Jong Un'], 0.85, 5).map((c) => c.uid), [20157]);
    // Listed names run together, and a legal form with doubled letters (each missed before).
    const em = new NameMatcher(readJson(join(FULL_MIRROR, 'names/entity.json')).entries, 'org', false);
    for (const [subject, uid] of [['Alqaida', 6366], ['Alshabaab', 10761], ['Hydramarket', 36216], ['HydraMarket LLC', 36216], ['Garantex LLC', 36025]]) {
        const [c] = em.screen([subject], 0.85, 3);
        assert.deepEqual([c?.uid, c?.score], [uid, 1], subject);
    }
    const t1 = REAL_NOW();
    const sample = ind.slice(0, 200).map((row) => row[1]);
    for (const name of sample) assert.ok(m.screen([name], 0.85, 3).some((c) => c.score === 1), name);
    console.log(`      ${sample.length} listed names each found themselves in ${REAL_NOW() - t1} ms`);
    console.log(`      (${checked} address records checked)`);
});

console.log(failures ? `\n${failures} step(s) failed` : '\nall steps passed');
process.exit(failures ? 1 : 0);
