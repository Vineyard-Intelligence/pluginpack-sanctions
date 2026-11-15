// Manifest fragments both plugins share.
import type { GraphScope, NetworkScope, PluginManifest, TypeRef } from './sdk';
import { MIRROR } from './mirror';

export const CRYPTO_PACK = 'run.vineyard.typepacks.cryptocurrency';
export const IDENTITY_PACK = 'run.vineyard.typepacks.identity';
export const FINANCIAL_PACK = 'run.vineyard.typepacks.financial';
export const crypto = (name: string): TypeRef => ({ typepack: CRYPTO_PACK, category: 'cryptocurrency', name });
export const identity = (name: string): TypeRef => ({ typepack: IDENTITY_PACK, category: 'identity', name });
export const financial = (name: string): TypeRef => ({ typepack: FINANCIAL_PACK, category: 'financial', name });

// PLATFORM: web and desktop. raw.githubusercontent.com answers with `Access-Control-Allow-Origin: *`,
// which is why the list is mirrored there at all (mirror.ts).
export const PLATFORMS: PluginManifest['platforms'] = {
    primary: 'web',
    web: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
    desktop: { runtime: 'sandbox-js', entry: 'dist/pack.mjs' },
};

// One network entry for both members, so the install gate shows one destination, and GET only.
export const NETWORK: NetworkScope[] = [
    {
        endpoint: MIRROR,
        methods: ['GET'],
        purpose: "Download OFAC's SDN list from the sanctions mirror: its index and the whole shard a screening needs. Nothing screened is sent.",
    },
];

// edge:read because a linked pair keeps its label (links.ts); node:create for listed parties and the
// network a listing settles; node:update for the sanctions fields.
export const GRAPH_SCOPES: GraphScope[] = ['node:read', 'node:create', 'node:update', 'edge:read', 'edge:create'];

export const LIFECYCLE: NonNullable<PluginManifest['lifecycle']> = {
    persistence: 'opt-in',
    controls: ['progress', 'cancel'],
    progress: 'determinate',
};

export const AUTHOR = { name: 'VINEYARD', url: 'https://vineyard.run' };
export const LICENSE = 'Apache-2.0';

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A long value shortened for a summary line. */
export const short = (s: string, max = 18): string => (s.length > max ? `${s.slice(0, max - 7)}…${s.slice(-6)}` : s);
