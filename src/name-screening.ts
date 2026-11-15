// OFAC Name Screening — which SDN entries the selected people and organisations could be.
//
// A NAME MATCH IS A CANDIDATE, NEVER A FINDING. Each candidate becomes the listed party's node
// (parties.ts) and a `possible sanctions match` edge from the subject carrying the score, the names
// that met and the programmes. Nothing is written on the subject that says it is sanctioned: the
// analyst confirms or dismisses each candidate against the date of birth, nationality and listing,
// in the review and afterwards. The subject records only that it was screened (`sanctions_screened_as_of`
// and `sanctions_screened_min_score`), so "no candidate" can be told from "never screened".
//
// A selected node that IS a listed party (made by this pack: `sanctions_uid` set) is re-checked by
// uid instead: its sanctions fields follow the list, and an entry gone from the list is written
// sanctioned = false.
//
// People are screened against individuals and organisations against entities, each against the
// whole shard downloaded once (mirror.ts), so no name leaves the device. Scoring is names.ts.
import { definePlugin } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import type { Party } from './address-match';
import { AUTHOR, GRAPH_SCOPES, LICENSE, LIFECYCLE, NETWORK, PLATFORMS, identity, plural } from './common';
import { LIST, Mirror, provenance, staleness } from './mirror';
import { NameMatcher, nonLatin, shownScore } from './names';
import type { Candidate, NameKind } from './names';
import { ORG, PERSON, Parties, dateOfBirthCheck, delta, isPartyNode, partyLabel, partySanctions } from './parties';
import { Links, keptLine } from './links';

export const DEFAULT_MIN_SCORE = 0.85;
export const MIN_MIN_SCORE = 0.75;
export const DEFAULT_MAX_CANDIDATES = 3;
export const MAX_MAX_CANDIDATES = 10;

type Row = [number, string, Array<[string, 'strong' | 'weak']>, string[], string[], string[], string[], string[]];
interface NameShard {
    format: number;
    as_of: string;
    type: string;
    fields: string[];
    entries: Row[];
}

const SHARD: Record<NameKind, string> = { person: 'names/individual.json', org: 'names/entity.json' };
const SDN_TYPE: Record<NameKind, Party['type']> = { person: 'Individual', org: 'Entity' };

const rowParty = (row: Row, kind: NameKind): Party => ({
    type: SDN_TYPE[kind],
    name: row[1],
    aliases: row[2],
    programs: row[3],
    dates_of_birth: row[4],
    places_of_birth: row[5],
    nationalities: row[6],
    citizenships: row[7],
});

/** A number param within [lo, hi], or the default when it is missing or not a number. */
function numberParam(v: unknown, dflt: number, lo: number, hi: number): number {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** The names a subject is screened by: its label and its aliases, as written. */
export function subjectNames(n: GraphNode): string[] {
    const label = n.type === PERSON ? n.data?.full_name : n.data?.name;
    const aliases = Array.isArray(n.data?.aliases) ? n.data!.aliases : [];
    return [...new Set([label, ...aliases].filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
}

export const nameScreening = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.sanctions_name_screening',
        content_type: 'vineyard:plugin',
        name: 'OFAC Name Screening',
        version: '1.0.0',
        description:
            "Compares each selected Person's name and aliases with the individuals on OFAC's SDN list, and each Organization's with the entities, and links every entry whose name scores at least Min score (0.85 unless set) as a \"possible sanctions match\" with the score, the names that met and the programmes. The match is a candidate to confirm against date of birth and nationality, not a finding: nothing marks the subject as sanctioned. A listed party this pack created is re-checked by its SDN uid instead. The list is downloaded whole and matched on this device; no name is sent.",
        icon: 'user-search',
        author: AUTHOR,
        license: LICENSE,
        platforms: PLATFORMS,
        io: {
            consumes: [identity('person'), identity('organization')],
            produces: [identity('person'), identity('organization')],
        },
        params: {
            type: 'object',
            properties: {
                min_score: {
                    type: 'number',
                    title: 'Min score',
                    description: `Lowest name score linked as a possible match, ${MIN_MIN_SCORE}–1 (default ${DEFAULT_MIN_SCORE}). 1 is the same words in any order.`,
                    minimum: MIN_MIN_SCORE,
                    maximum: 1,
                    default: DEFAULT_MIN_SCORE,
                },
                max_candidates: {
                    type: 'integer',
                    title: 'Max candidates',
                    description: `Possible matches linked per node, best first, 1–${MAX_MAX_CANDIDATES} (default ${DEFAULT_MAX_CANDIDATES}).`,
                    minimum: 1,
                    maximum: MAX_MAX_CANDIDATES,
                    default: DEFAULT_MAX_CANDIDATES,
                },
                include_weak_aliases: {
                    type: 'boolean',
                    title: 'Include weak aliases',
                    description: 'Also match aliases OFAC marks weak: too broad to identify anyone by themselves (e.g. "HIDDEN COBRA" for Lazarus Group).',
                    default: false,
                },
            },
        },
        scopes: { graph: GRAPH_SCOPES, network: NETWORK },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        const counts = {
            screened: 0,
            with_candidates: 0,
            without_candidates: 0,
            candidates: 0,
            parties_rechecked: 0,
            parties_delisted: 0,
            parties_created: 0,
            not_latin: 0,
            links_kept: 0,
            skipped: 0,
            missing: 0,
            refused: 0,
        };
        const ids = ctx.input.selection ?? [];
        if (!ids.length) return { summary: 'Select one or more Person or Organization nodes to screen.', counts };
        const minScore = numberParam(ctx.params?.min_score, DEFAULT_MIN_SCORE, MIN_MIN_SCORE, 1);
        const maxCandidates = Math.round(numberParam(ctx.params?.max_candidates, DEFAULT_MAX_CANDIDATES, 1, MAX_MAX_CANDIDATES));
        const includeWeak = ctx.params?.include_weak_aliases === true;

        const subjects: Array<{ node: GraphNode; kind: NameKind }> = [];
        for (const id of ids) {
            const n = await ctx.graph!.get!(id);
            if (!n) counts.missing++;
            else if (n.type === PERSON) subjects.push({ node: n, kind: 'person' });
            else if (n.type === ORG) subjects.push({ node: n, kind: 'org' });
            else counts.skipped++;
        }
        if (!subjects.length) {
            return { summary: `Nothing to screen: select Person or Organization nodes (${plural(counts.skipped, 'node')} of other types skipped).`, counts };
        }

        // Every shard the selection needs is read before anything is written, so a mirror failure
        // fails the run with nothing staged. The Mirror reads the index once and every shard at the
        // content path that index names, so the shards are one build and `asOf` is that build's date
        // (mirror.ts): a person and an organisation screened in one run meet the same list, and the
        // date written on every result is the list they met.
        const mirror = new Mirror(ctx);
        const idx = await mirror.index();
        const kinds = [...new Set(subjects.map((s) => s.kind))];
        const shards = new Map<NameKind, NameShard>();
        for (const k of kinds) shards.set(k, await mirror.file<NameShard>(SHARD[k]));
        const asOf = idx.source.publish_date;
        const rows = new Map<NameKind, Map<number, Row>>();
        for (const [k, shard] of shards) rows.set(k, new Map(shard.entries.map((r) => [r[0], r])));
        // Built on first use: a selection of party nodes alone only needs the rows.
        const matchers = new Map<NameKind, NameMatcher>();

        const parties = new Parties(ctx, asOf);
        const links = new Links(ctx);
        const found: string[] = [];
        const refused: string[] = [];

        for (let i = 0; i < subjects.length; i++) {
            if (ctx.signal?.aborted) break;
            const { node, kind } = subjects[i];
            ctx.progress?.set?.({ percent: Math.round(((i + 1) / subjects.length) * 100), message: `${i + 1}/${subjects.length} screened` });
            const write = async (want: Record<string, unknown>) => {
                const patch = delta(node.data, want);
                if (!patch) return;
                try {
                    await ctx.graph!.updateNode!(String(node.id), patch);
                } catch (e) {
                    counts.refused++;
                    refused.push(`${subjectNames(node)[0] ?? node.id}: ${e instanceof Error ? e.message : String(e)}`);
                }
            };

            if (isPartyNode(node)) {
                counts.parties_rechecked++;
                const uid = Number(node.data!.sanctions_uid);
                const row = rows.get(kind)!.get(uid);
                if (row) {
                    await write(partySanctions(uid, rowParty(row, kind), asOf));
                } else {
                    counts.parties_delisted++;
                    await write({ sanctioned: false, sanctions_programs: [], sanctions_as_of: asOf });
                }
                continue;
            }

            const names = subjectNames(node);
            if (!names.length) {
                counts.skipped++;
                continue;
            }
            counts.screened++;
            if (names.every(nonLatin)) counts.not_latin++;
            let matcher = matchers.get(kind);
            if (!matcher) {
                matcher = new NameMatcher(shards.get(kind)!.entries, kind, includeWeak);
                matchers.set(kind, matcher);
            }
            const cands: Candidate[] = matcher.screen(names, minScore, maxCandidates);
            let linked = 0;
            for (const c of cands) {
                const row = rows.get(kind)!.get(c.uid);
                if (!row) continue;
                const party = rowParty(row, kind);
                const got = await parties.ensure(c.uid, party);
                if (!got || 'refused' in got || got.id === String(node.id)) continue;
                const data: Record<string, unknown> = {
                    list: LIST,
                    uid: String(c.uid),
                    score: shownScore(c.score),
                    subject_name: c.subjectName,
                    listed_name: c.listedName,
                    matched_on: c.via,
                    program: [...party.programs].sort(),
                    as_of: asOf,
                    min_score: minScore,
                };
                const dob = kind === 'person' ? dateOfBirthCheck(node.data?.date_of_birth, party.dates_of_birth) : null;
                if (dob) data.date_of_birth_check = dob;
                const r = await links.link(String(node.id), got.id, 'possible sanctions match', data);
                if (r !== 'refused') linked++;
            }
            counts.candidates += linked;
            if (linked) {
                counts.with_candidates++;
                const top = cands[0];
                found.push(`${names[0]} → ${partyLabel(rows.get(kind)!.get(top.uid)![1], top.uid)} ${shownScore(top.score).toFixed(2)}${linked > 1 ? ` (+${linked - 1})` : ''}`);
            } else {
                counts.without_candidates++;
            }
            await write({ sanctions_screened_as_of: asOf, sanctions_screened_min_score: minScore });
        }
        counts.parties_created = parties.created;
        counts.links_kept = links.kept;
        counts.refused += parties.refused.length + links.refused.length;
        refused.push(...parties.refused, ...links.refused);

        const lines = [
            `Screened ${plural(counts.screened, 'name')} against the ${LIST} list of ${asOf} at score ≥ ${minScore}: ${counts.with_candidates} with possible matches, ${counts.without_candidates} without.`,
        ];
        if (found.length) lines.push(`Best: ${found.slice(0, 5).join(' · ')}${found.length > 5 ? ` · and ${found.length - 5} more` : ''}.`);
        if (counts.with_candidates) lines.push('A possible match is a similar name, not the same party: compare date of birth, nationality and the listing on the party node before treating it as one.');
        if (counts.not_latin) lines.push(`${plural(counts.not_latin, 'name')} not in Latin script met nothing: the list is in Latin script, so screen a romanized alias.`);
        if (counts.parties_rechecked) {
            lines.push(`${plural(counts.parties_rechecked, 'listed party', 'listed parties')} re-checked by uid${counts.parties_delisted ? `, ${counts.parties_delisted} no longer on the list (written sanctioned = false)` : ''}.`);
        }
        const kept = keptLine(links.kept);
        if (kept) lines.push(kept);
        if (counts.skipped) lines.push(`${plural(counts.skipped, 'node')} skipped (other types, or no name).`);
        if (refused.length) lines.push(`Not written: ${refused.slice(0, 3).join('; ')}${refused.length > 3 ? ` and ${refused.length - 3} more` : ''}.`);
        if (ctx.signal?.aborted) lines.push(`Cancelled after ${counts.screened + counts.parties_rechecked} of ${subjects.length}.`);
        for (const warning of [provenance(idx), staleness(idx)]) if (warning) lines.push(warning);
        return { summary: lines.join(' '), counts };
    },
});
