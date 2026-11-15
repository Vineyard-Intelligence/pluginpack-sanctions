// Bundles src/main.ts into dist/pack.mjs — the single artifact the registry serves. Everything is
// inlined (the SDK is types plus identity helpers, crypto-address.ts and names.ts are pure), because
// the module is fetched by URL in a Web Worker with no import map: any bare specifier left in it
// would fail. There are no dependencies, so there is no lockfile to pin.
//
// esbuild is pinned so that anyone can check the published bundle against this source:
//
//   node build.mjs && git diff --exit-code dist/pack.mjs
//
// The version is not cosmetic: esbuild 0.27.5 started declaring a class field for each TypeScript
// parameter property, so a floating `npx esbuild` changed other packs' bytes with no change to their
// source. This pack writes its fields out instead, and keeps the pin the other packs use.
//
// Usage: node build.mjs   (then node gen-manifest.mjs)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });

execFileSync(
    'npx',
    [
        '--yes',
        'esbuild@0.25.12',
        join(here, 'src', 'main.ts'),
        '--bundle',
        '--format=esm',
        '--target=es2022',
        '--platform=browser',
        '--minify',
        '--legal-comments=inline', // never strip a licence header out of a pack
        '--log-level=warning',
        `--outfile=${join(here, 'dist', 'pack.mjs')}`,
    ],
    { stdio: 'inherit', cwd: here },
);

console.log('wrote dist/pack.mjs — run `node gen-manifest.mjs` next to refresh the manifest.');
