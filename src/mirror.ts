// Reading the sanctions mirror: index.json, then the shards a run needs, each checked against the
// SHA-256 the index gives for it.
//
// WHY A MIRROR: OFAC's SDN.XML cannot be read from a page. Its API answers with a 302 that allows any
// origin, to an S3 pre-signed URL that sends no CORS header (measured 2026-11-14), so the worker's
// request fails at the second hop. Vineyard-Intelligence/sanctions-mirror rebuilds the file every six
// hours, checked against OFAC's own digest, as JSON on raw.githubusercontent.com, which a page can
// read in the web build and the desktop app alike. Its README says how a build is checked.
//
// WHY CONTENT PATHS: raw.githubusercontent.com caches each path for five minutes, and its cache key
// leaves out the query string (measured 2026-11-15: different random queries on one path came back
// as one cache object, its age counting up). So right after an update an edge can hold index.json
// from one build and addresses.json from the next, and no `?v=` or `?t=` reaches past it. The mirror
// therefore also publishes each file at `data/<its SHA-256>.json` and keeps the previous build's
// until the next one: whichever index this run gets, the files it names are that build's, and every
// shard a run reads comes from the one index it read first. The bytes are still checked against the
// hash, and a shard whose `as_of` is not the index's date is refused, so a run never screens against
// half of two lists.
//
// A content path that is not there yet (an edge that still has the old commit) falls back to the
// file's name, which is accepted only if it hashes to the same value. Anything else stops the run
// before anything is staged.
//
// WHO SEES WHAT: GitHub sees that the index and a shard were downloaded. A run reads a whole shard —
// every address, or every person, or every entity — and matches locally, so no address or name
// leaves the device.
import type { HostContext } from './sdk';
import { sha256 } from './crypto-address';

export const MIRROR = 'https://raw.githubusercontent.com/Vineyard-Intelligence/sanctions-mirror/main';
export const MIRROR_FORMAT = 1;
export const LIST = 'OFAC SDN';

/** The mirror re-checks OFAC every six hours and records it at least daily (its README). Three days
 *  without a recorded check means the mirror stalled, and designations since then are missing. */
export const STALE_HOURS = 72;

export interface MirrorIndex {
    format: number;
    list: string;
    source: { url: string; publish_date: string; record_count: number; sha256: string; digest_verified?: boolean };
    generator?: string;
    checked_at: string;
    files: Record<string, { sha256: string; bytes: number }>;
}

/** Where the mirror publishes a file with this SHA-256 (its layout.mjs). */
export const dataPath = (sha: string): string => `data/${sha}.json`;

/** A failure that means no screening happened. Thrown before anything is staged. */
export class MirrorError extends Error {}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (text: string): string => hex(sha256(new TextEncoder().encode(text)));

export function checkIndex(raw: unknown): MirrorIndex {
    const idx = raw as MirrorIndex;
    if (!idx || typeof idx !== 'object') throw new MirrorError('The sanctions mirror returned no index.');
    if (idx.format !== MIRROR_FORMAT) {
        throw new MirrorError(
            `The sanctions mirror is in format ${String(idx.format)}, and this pack reads format ${MIRROR_FORMAT}. Update the Sanctions Screening pack.`,
        );
    }
    if (idx.list !== LIST || !idx.source?.publish_date || !idx.files) throw new MirrorError('The sanctions mirror index is not an OFAC SDN index.');
    return idx;
}

/** Hours since the mirror last recorded a check of OFAC's list, or Infinity when it never did. */
export function hoursSinceCheck(idx: MirrorIndex, now = Date.now()): number {
    const t = Date.parse(idx.checked_at);
    return Number.isFinite(t) ? (now - t) / 3_600_000 : Infinity;
}

/** One line for a run summary when the mirror is too old to trust as current, else ''. */
export function staleness(idx: MirrorIndex, now = Date.now()): string {
    const h = hoursSinceCheck(idx, now);
    if (h <= STALE_HOURS) return '';
    const when = Number.isFinite(h) ? `${Math.floor(h / 24)} days ago` : 'never';
    return `The mirror last checked OFAC's list ${when} (${idx.checked_at || 'no date'}): designations since then are missing. Check OFAC's Sanctions List Search before relying on a result.`;
}

/**
 * One line for a run summary when the index does not say its source matched OFAC's digest, else ''.
 * The mirror's update refuses a download it cannot check, so its own builds always say true; a
 * build made by hand (build.mjs without --digest-verified) says false, and a reader should know.
 */
export function provenance(idx: MirrorIndex): string {
    if (idx.source.digest_verified === true) return '';
    return "This copy of the list was not checked against OFAC's digest when the mirror built it. Check OFAC's Sanctions List Search before relying on a result.";
}

export class Mirror {
    private idx: MirrorIndex | null = null;
    private cache = new Map<string, unknown>();
    private ctx: HostContext;

    constructor(ctx: HostContext) {
        this.ctx = ctx;
    }

    /** The body, or null on a 404; any other failure throws. */
    private async get(path: string): Promise<string | null> {
        const fetch = this.ctx.net?.fetch;
        if (!fetch) throw new MirrorError('This plugin was not granted its network permission, so it cannot read the sanctions mirror.');
        let res;
        try {
            res = await fetch(`${MIRROR}/${path}`, { method: 'GET' });
        } catch (e) {
            throw new MirrorError(`Could not reach the sanctions mirror (${e instanceof Error ? e.message : String(e)}). Nothing was screened.`);
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new MirrorError(`The sanctions mirror answered HTTP ${res.status} for ${path}. Nothing was screened.`);
        return res.text();
    }

    /** The index, read once per run: every shard this run reads is the build it names. */
    async index(): Promise<MirrorIndex> {
        if (this.idx) return this.idx;
        const text = await this.get('index.json');
        if (text === null) throw new MirrorError('The sanctions mirror answered HTTP 404 for index.json. Nothing was screened.');
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new MirrorError('The sanctions mirror index is not JSON. Nothing was screened.');
        }
        this.idx = checkIndex(parsed);
        return this.idx;
    }

    /** A shard of the index's build, parsed, after its bytes matched the index. */
    async file<T>(path: string): Promise<T> {
        if (this.cache.has(path)) return this.cache.get(path) as T;
        const idx = await this.index();
        const meta = idx.files[path];
        if (!meta || !/^[0-9a-f]{64}$/.test(String(meta.sha256))) throw new MirrorError(`The sanctions mirror has no ${path}. Update the Sanctions Screening pack.`);
        for (const at of [dataPath(meta.sha256), path]) {
            const text = await this.get(at);
            if (text === null || sha256Hex(text) !== meta.sha256) continue;
            let parsed: T & { as_of?: string };
            try {
                parsed = JSON.parse(text) as T & { as_of?: string };
            } catch {
                break;
            }
            if (parsed.as_of !== idx.source.publish_date) break;
            this.cache.set(path, parsed);
            return parsed;
        }
        throw new MirrorError(
            `The sanctions mirror's ${path} for the list of ${idx.source.publish_date} is not available as its index describes it: the mirror is probably being updated. Run again in a few minutes. Nothing was screened.`,
        );
    }
}
