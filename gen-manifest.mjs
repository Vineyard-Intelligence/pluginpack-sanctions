#!/usr/bin/env node
/**
 * Emit plugins/sanctions.manifest.json from the BUILT bundle.
 *
 * The manifest and the code it describes are two copies of the same declaration — scopes, io,
 * params, versions — and a hand-maintained JSON drifts from the code the moment one of them
 * changes. The registry pins a commit and the client reads the manifest from it, so a drifted
 * manifest describes code that does something else. Generating it means the two cannot disagree.
 *
 * Usage: node gen-manifest.mjs   (after build.mjs)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pack = (await import(join(here, 'dist', 'pack.mjs'))).default;

if (!pack?.plugins?.length) {
    console.error('dist/pack.mjs has no plugins — run build.mjs first');
    process.exit(1);
}

/** `author` and `license` are pack-level only — the member schema rejects them. */
function member(m) {
    const { author, license, ...rest } = m;
    return rest;
}

const manifest = {
    identifier: pack.identifier,
    content_type: 'vineyard:pluginpack',
    name: pack.name,
    version: pack.version,
    summary: pack.summary,
    description: pack.description,
    author: { name: 'VINEYARD', url: 'https://github.com/Vineyard-Intelligence' },
    license: pack.license,
    icon: pack.icon,
    platforms: pack.platforms,
    plugins: pack.plugins.map((p) => member(p.manifest)),
};

const out = join(here, 'plugins', 'sanctions.manifest.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote plugins/sanctions.manifest.json (${manifest.plugins.length} plugins, v${manifest.version})`);
