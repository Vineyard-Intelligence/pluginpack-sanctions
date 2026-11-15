// The listed party as a node: one per SDN entry, shared by both plugins.
//
// ONE NODE PER ENTRY, NAMED WITH ITS UID. Identity's person and organization are identified by name
// alone, and names on the list collide: the 2026-11-13 list has 24 names held by two or more entries
// ("KIM, Yong Chol" is two people born 15 years apart, "MINISTRY OF STATE SECURITY" is North Korea's
// and Russia's). Named as OFAC writes them, the second would merge into the first and overwrite its
// date of birth. So the label is "KIM, Yong Chol (OFAC SDN 12211)": stable across list updates,
// never merged with a namesake, and never with the analyst's own node for the person they are
// investigating — that link is what Name Screening proposes, for the analyst to accept or not.
//
// AN EXISTING PARTY NODE IS REUSED, not rewritten: only its sanctions fields follow the list. Its
// name, aliases and dates stay as they are, so an analyst's corrections survive a re-run.
//
// IT IS FOUND BY ITS UID FIRST, and by label only when no node carries the uid. The label is built
// from OFAC's primary name, which OFAC corrects and companies change, and which the analyst may
// edit; looked up by label alone, either made a second node for the same entry on the next run, with
// the listing split between the two and the old one frozen at the earlier date.
import type { GraphNode, HostContext } from './sdk';
import type { Party } from './address-match';
import { LIST } from './mirror';

export const PERSON = 'identity.person';
export const ORG = 'identity.organization';
const LABEL_FIELD: Record<string, string> = { [PERSON]: 'full_name', [ORG]: 'name' };

/** Vessels and aircraft get no node: Identity has no type for them, and none lists an address. */
export const partyType = (p: Party): string | null => (p.type === 'Individual' ? PERSON : p.type === 'Entity' ? ORG : null);

export const partyLabel = (name: string, uid: number | string): string => `${name} (${LIST} ${uid})`;

const MONTHS: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "08 Jan 1984" → "1984-01-08"; anything vaguer (a year, "circa", a range) → null. */
export function exactDate(text: string): string | null {
    const m = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(String(text).trim());
    if (!m || !MONTHS[m[2]]) return null;
    const iso = `${m[3]}-${MONTHS[m[2]]}-${m[1]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** The years a listed date of birth allows: "1984", "08 Jan 1984", "circa 1979" (±1), "1984 to 1986". */
export function yearsOf(text: string): [number, number] | null {
    const years = [...String(text).matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
    if (!years.length) return null;
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    return /circa/i.test(text) ? [lo - 1, hi + 1] : [lo, hi];
}

/**
 * How a subject's date of birth (YYYY-MM-DD, or a year) sits against the listed ones: "same date",
 * "same year", "different year", or null when either side has none. Nationality gets no such check:
 * the list writes "Korea, North" where a node may say "DPRK", and a false "differs" would argue
 * against a real match.
 */
export function dateOfBirthCheck(subject: unknown, listed: string[]): string | null {
    const s = typeof subject === 'string' ? subject.trim() : '';
    const year = Number(/^(\d{4})/.exec(s)?.[1]);
    if (!year || !listed.length) return null;
    if (listed.some((d) => exactDate(d) === s)) return 'same date';
    if (listed.some((d) => {
        const r = yearsOf(d);
        return r !== null && year >= r[0] && year <= r[1];
    })) return 'same year';
    return 'different year';
}

const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** The sanctions fields a listed party carries, as the list states them on `asOf`. */
export const partySanctions = (uid: number, p: Party, asOf: string) => ({
    sanctioned: true,
    sanctions_list: LIST,
    sanctions_uid: String(uid),
    sanctions_programs: [...p.programs].sort(),
    sanctions_as_of: asOf,
});

/** A new party node's data. Undeclared keys (sanctions_*, listed_*) pass validation on purpose. */
export function partyData(uid: number, p: Party, asOf: string): Record<string, unknown> {
    const type = partyType(p);
    const strong = p.aliases.filter(([, c]) => c === 'strong').map(([n]) => n);
    const out: Record<string, unknown> = { [LABEL_FIELD[type ?? ORG]]: partyLabel(p.name, uid) };
    out.aliases = unique([p.name, ...strong]);
    if (type === PERSON) {
        const exact = p.dates_of_birth.length === 1 ? exactDate(p.dates_of_birth[0]) : null;
        if (exact) out.date_of_birth = exact;
        else if (p.dates_of_birth.length) out.listed_dates_of_birth = p.dates_of_birth;
        const nat = unique(p.nationalities.length ? p.nationalities : p.citizenships);
        if (nat.length) out.nationality = nat.join('; ');
        if (p.places_of_birth.length) out.listed_places_of_birth = p.places_of_birth;
    }
    return { ...out, ...partySanctions(uid, p, asOf) };
}

/** Whether a node is a listed party a run of this pack made (or one shaped like it). */
export const isPartyNode = (n: GraphNode): boolean =>
    n.data?.sanctions_list === LIST && typeof n.data?.sanctions_uid === 'string' && n.data.sanctions_uid !== '';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The keys of `want` whose value differs from `data`'s: what an update has to write. */
export function delta(data: Record<string, unknown> | undefined, want: Record<string, unknown>): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(want)) if (!same(data?.[k], v)) out[k] = v;
    return Object.keys(out).length ? out : null;
}

export type EnsureResult = { id: string; created: boolean; refreshed: boolean } | { refused: string } | null;

const uidKey = (type: string, uid: number | string) => `${type}\0uid\0${uid}`;
const labelKey = (type: string, label: string) => `${type}\0label\0${label}`;

/** Party nodes for one run: found by uid, then by label, and created when the project has neither. */
export class Parties {
    private ctx: HostContext;
    private asOf: string;
    private existing: Map<string, GraphNode> | null = null;
    private made = new Map<string, string>(); // uidKey -> id, this run
    created = 0;
    reused = 0;
    refreshed = 0;
    refused: string[] = [];

    constructor(ctx: HostContext, asOf: string) {
        this.ctx = ctx;
        this.asOf = asOf;
    }

    private async index(): Promise<Map<string, GraphNode>> {
        if (this.existing) return this.existing;
        const out = new Map<string, GraphNode>();
        const put = (k: string, n: GraphNode) => {
            if (!out.has(k)) out.set(k, n);
        };
        for (const type of [PERSON, ORG]) {
            try {
                const { nodes } = (await this.ctx.graph?.list?.({ type })) ?? { nodes: [] };
                for (const n of nodes) {
                    if (n.type !== type) continue;
                    if (isPartyNode(n)) put(uidKey(type, String(n.data.sanctions_uid)), n);
                    const label = n.data?.[LABEL_FIELD[type]];
                    if (typeof label === 'string') put(labelKey(type, label), n);
                }
            } catch {
                /* unreadable: nothing is reused, and createNode still de-duplicates by label */
            }
        }
        this.existing = out;
        return out;
    }

    async ensure(uid: number, p: Party | undefined): Promise<EnsureResult> {
        if (!p) return null;
        const type = partyType(p);
        if (!type) return null;
        const label = partyLabel(p.name, uid);
        const key = uidKey(type, uid);
        const made = this.made.get(key);
        if (made) return { id: made, created: false, refreshed: false };

        const idx = await this.index();
        const found = idx.get(key) ?? idx.get(labelKey(type, label));
        if (found) {
            this.made.set(key, String(found.id));
            this.reused++;
            const patch = delta(found.data, partySanctions(uid, p, this.asOf));
            let refreshed = false;
            if (patch) {
                try {
                    await this.ctx.graph!.updateNode!(String(found.id), patch);
                    this.refreshed++;
                    refreshed = true;
                } catch (e) {
                    this.refused.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            return { id: String(found.id), created: false, refreshed };
        }
        try {
            const node = await this.ctx.graph!.createNode!({ type, data: partyData(uid, p, this.asOf) });
            this.made.set(key, String(node.id));
            this.created++;
            return { id: String(node.id), created: true, refreshed: false };
        } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            this.refused.push(`${label}: ${why}`);
            return { refused: why };
        }
    }
}
