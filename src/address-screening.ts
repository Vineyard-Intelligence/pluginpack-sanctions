// OFAC Address Screening — whether the selected crypto addresses are on the SDN list.
//
// WHAT IT WRITES on each screened address: `sanctioned` (true or false), `sanctions_list` (OFAC
// SDN), `sanctions_programs` and `sanctions_as_of`, the publish date of the list it was screened
// against. `false` is written too: it records "not on the list of that date", which is the
// screening's answer, and it is how a delisting reaches a node that an earlier list had marked —
// Tornado Cash's addresses came off the list on 2025-03-21, and a pack that wrote only hits would
// have left them `true` for good.
//
// BUT ONLY OVER ITS OWN ANSWER. The type pack's `sanctioned` means "on a sanctions list", any list.
// A node already marked `true` with no `sanctions_list`, or another list's, is someone else's claim
// (an analyst's, an EU or UK designation), and OFAC not listing the address does not refute it. Such
// a node's fields are left as they are and the summary says so; when OFAC does list it, the listing
// is still drawn as its `listed address` link. The same holds for an address node the list settles
// (below) that the project already has: it is reached by its identity first and written only after
// its fields are read, because createNode merges what it is given over what is there.
//
// FOR A LISTED ADDRESS: the entry that lists it becomes an Identity node (parties.ts), linked to the
// address by `listed address` with the Cryptocurrency pack's keys (`list`, `uid`, `program`, `as_of`)
// and every code OFAC lists it under (`listed_as`). One entry can list one 0x value under ETH and,
// with no chain, under USDT (the mirror's `ethereum` and `evm` records), so the codes are gathered
// across every record that applies before the one link is drawn.
//
// FOR AN ADDRESS WHOSE NETWORK IS NOT ESTABLISHED (`evm`, `unknown`, or the Financial pack's legacy
// type, unless its `currency` names one network: btc, ltc, xmr, trx, sol): the listing settles it. Each network the list names the string on gets its own address node,
// linked from the original by `same address on` (by `same as` from the legacy type), and the listing
// goes on that node. The original keeps its network, and its own sanctioned fields say whether the
// string is listed at all.
//
// Nothing about the screened values leaves the device: the whole address shard is downloaded and
// matched here (mirror.ts).
import { definePlugin } from './sdk';
import type { GraphNode, HostContext, RunResult } from './sdk';
import { AddressIndex, EVM_NETWORKS, legacyNetwork, onNetwork, programsOf } from './address-match';
import type { AddressRecord, AddressShard } from './address-match';
import { AUTHOR, GRAPH_SCOPES, LICENSE, LIFECYCLE, NETWORK, PLATFORMS, crypto, financial, identity, plural, short } from './common';
import { LIST, Mirror, provenance, staleness } from './mirror';
import { Parties, delta } from './parties';
import { Links, keptLine } from './links';

export const CRYPTO_ADDRESS = 'cryptocurrency.crypto_address';
export const LEGACY_ADDRESS = 'financial.crypto_address';

/** A `sanctioned: true` this pack did not write: by hand, or from another list. */
export const otherSourceClaim = (data: Record<string, unknown> | undefined): boolean => data?.sanctioned === true && data?.sanctions_list !== LIST;

/** The sanctions fields an address should carry after this screening, or null to leave them. */
export function addressSanctions(data: Record<string, unknown> | undefined, programs: string[] | null, asOf: string): Record<string, unknown> | null {
    if (otherSourceClaim(data)) return null;
    if (programs) return { sanctioned: true, sanctions_list: LIST, sanctions_programs: programs, sanctions_as_of: asOf };
    const had = Array.isArray(data?.sanctions_programs) && data!.sanctions_programs.length > 0;
    // [] is not blank to the host's fill-merge, so a delisting can clear the programmes.
    return { sanctioned: false, sanctions_list: LIST, ...(had ? { sanctions_programs: [] } : {}), sanctions_as_of: asOf };
}

export const addressScreening = definePlugin({
    manifest: {
        identifier: 'run.vineyard.plugins.sanctions_address_screening',
        content_type: 'vineyard:plugin',
        name: 'OFAC Address Screening',
        version: '1.0.0',
        description:
            "Checks each selected Crypto Address against the digital currency addresses on OFAC's SDN list, on the address's own network, and writes sanctioned (true or false), sanctions_list, sanctions_programs and sanctions_as_of (the list's publish date); an address already marked sanctioned by another source is left as it is. A listed address is linked from the listed person or organization by \"listed address\" with the SDN uid and programmes. An address on network evm or unknown, or a legacy Financial address, gets one node per network the list names it on, linked by \"same address on\" or \"same as\"; a legacy address whose currency names one chain (btc, ltc, xmr, trx, sol) is screened on that chain only. The list is downloaded whole and matched on this device; no address is sent.",
        icon: 'wallet',
        author: AUTHOR,
        license: LICENSE,
        platforms: PLATFORMS,
        io: {
            consumes: [crypto('crypto_address'), financial('crypto_address')],
            produces: [crypto('crypto_address'), identity('person'), identity('organization')],
        },
        scopes: { graph: GRAPH_SCOPES, network: NETWORK },
        lifecycle: LIFECYCLE,
    },

    async run(ctx: HostContext): Promise<RunResult> {
        const counts = {
            screened: 0,
            listed: 0,
            not_listed: 0,
            delisted: 0,
            updated: 0,
            networks_settled: 0,
            parties_created: 0,
            parties_linked: 0,
            listed_elsewhere: 0,
            other_source: 0,
            links_kept: 0,
            skipped: 0,
            missing: 0,
            refused: 0,
        };
        const ids = ctx.input.selection ?? [];
        if (!ids.length) return { summary: 'Select one or more Crypto Address nodes to screen.', counts };

        // Read the selection before the list, so a selection with nothing to screen costs no download.
        const subjects: GraphNode[] = [];
        for (const id of ids) {
            const n = await ctx.graph!.get!(id);
            if (!n) counts.missing++;
            else if (n.type === CRYPTO_ADDRESS || n.type === LEGACY_ADDRESS) subjects.push(n);
            else counts.skipped++;
        }
        if (!subjects.length) {
            return { summary: `Nothing to screen: select Crypto Address nodes (${plural(counts.skipped, 'node')} of other types skipped).`, counts };
        }

        // A mirror failure throws here, before anything is staged: the run fails and says why.
        const mirror = new Mirror(ctx);
        const idx = await mirror.index();
        const shard = await mirror.file<AddressShard>('addresses.json');
        const index = new AddressIndex(shard);
        const asOf = shard.as_of;
        const parties = new Parties(ctx, asOf);
        const links = new Links(ctx);

        const hits: string[] = [];
        const settled: string[] = [];
        const elsewhere: string[] = [];
        const refused: string[] = [];
        const otherSource = new Set<string>();
        let needCrypto = false;

        /** This screening's answer on `node`, unless another source's claim is there. True when staged. */
        const writeSanctions = async (node: GraphNode, programs: string[] | null, shown: string): Promise<boolean> => {
            if (otherSourceClaim(node.data)) otherSource.add(String(node.id));
            const want = addressSanctions(node.data, programs, asOf);
            const patch = want && delta(node.data, want);
            if (!patch) return false;
            try {
                await ctx.graph!.updateNode!(String(node.id), patch);
                return true;
            } catch (e) {
                counts.refused++;
                refused.push(`${shown}: ${e instanceof Error ? e.message : String(e)}`);
                return false;
            }
        };

        /** `listed address` from every entry behind `records` to `target`: one link per entry. */
        const linkParties = async (records: AddressRecord[], target: string) => {
            const byUid = new Map<number, { codes: string[]; listed: string[] }>();
            for (const l of records.flatMap((r) => r.listings)) {
                const slot = byUid.get(l.uid) ?? { codes: [], listed: [] };
                if (!slot.codes.includes(l.code)) slot.codes.push(l.code);
                if (l.listed && !slot.listed.includes(l.listed)) slot.listed.push(l.listed);
                byUid.set(l.uid, slot);
            }
            for (const [uid, slot] of byUid) {
                const party = shard.parties[String(uid)];
                const got = await parties.ensure(uid, party);
                if (!got || 'refused' in got) continue;
                const data: Record<string, unknown> = {
                    list: LIST,
                    uid: String(uid),
                    program: [...(party?.programs ?? [])].sort(),
                    listed_as: slot.codes.sort(),
                    as_of: asOf,
                };
                if (slot.listed.length) data.listed = slot.listed;
                const r = await links.link(got.id, target, 'listed address', data);
                if (r === 'created' || r === 'updated') counts.parties_linked++;
            }
        };

        for (let i = 0; i < subjects.length; i++) {
            if (ctx.signal?.aborted) break;
            const node = subjects[i];
            ctx.progress?.set?.({ percent: Math.round(((i + 1) / subjects.length) * 100), message: `${i + 1}/${subjects.length} screened` });
            counts.screened++;
            const legacy = node.type === LEGACY_ADDRESS;
            const network = legacy ? null : String(node.data?.network ?? 'unknown');
            // A legacy node has no network, but its currency may name one (address-match.ts).
            const named = legacy ? legacyNetwork(node.data?.currency) : null;
            const address = String(node.data?.address ?? '');
            const matched = index.match(network, address);
            const m = named ? onNetwork(matched, named) : matched;
            const found = [...m.listed, ...m.resolved];
            const programs = found.length ? programsOf(found, shard.parties) : null;
            const shown = `${short(address)}${network ? ` (${network})` : named ? ` (${named})` : ''}`;

            if (found.length) counts.listed++;
            else counts.not_listed++;
            if (!found.length && node.data?.sanctioned === true && !otherSourceClaim(node.data)) counts.delisted++;

            if (await writeSanctions(node, programs, shown)) counts.updated++;

            if (m.listed.length) await linkParties(m.listed, String(node.id));

            // An `evm` listing names the address on every EVM network (address-match.ts), so a chain
            // node the list settles carries it beside that chain's own listing.
            const anyChain = found.filter((r) => r.network === 'evm');
            for (const rec of m.resolved) {
                const codes = [...new Set(rec.listings.map((l) => l.code))].sort();
                const applies = rec.network !== 'evm' && EVM_NETWORKS.has(rec.network) ? [rec, ...anyChain] : [rec];
                let target: GraphNode;
                try {
                    // The identity alone: a node the project already has comes back with its fields,
                    // and the sanctions fields are written over them only by the rule above. Given the
                    // fields here, createNode would merge them over another list's claim.
                    target = await ctx.graph!.createNode!({ type: CRYPTO_ADDRESS, data: { network: rec.network, address: rec.address } });
                } catch (e) {
                    const why = e instanceof Error ? e.message : String(e);
                    if (/not defined by any installed typepack/.test(why)) needCrypto = true;
                    counts.refused++;
                    refused.push(`${rec.network} ${short(rec.address)}: ${why}`);
                    continue;
                }
                counts.networks_settled++;
                await writeSanctions(target, programsOf(applies, shard.parties), `${short(rec.address)} (${rec.network})`);
                await links.link(String(node.id), String(target.id), legacy ? 'same as' : 'same address on', {
                    basis: `${LIST} lists this address on ${rec.network} (as ${codes.join(', ')})`,
                    as_of: asOf,
                });
                await linkParties(applies, String(target.id));
                settled.push(`${short(address)} → ${rec.network}`);
            }

            if (found.length) {
                const who = [...new Set(found.flatMap((r) => r.listings.map((l) => shard.parties[String(l.uid)]?.name ?? `uid ${l.uid}`)))];
                hits.push(`${shown} — ${who.slice(0, 2).join('; ')}${who.length > 2 ? ` and ${who.length - 2} more` : ''} [${programs!.join(', ')}]`);
            }
            if (m.elsewhere.length) {
                counts.listed_elsewhere++;
                elsewhere.push(`${shown} is listed on ${[...new Set(m.elsewhere.map((r) => r.network))].join(', ')}`);
            }
        }
        counts.parties_created = parties.created;
        counts.other_source = otherSource.size;
        counts.links_kept = links.kept;
        counts.refused += parties.refused.length + links.refused.length;
        refused.push(...parties.refused, ...links.refused);

        const lines = [
            `Screened ${plural(counts.screened, 'address', 'addresses')} against the ${LIST} list of ${asOf}: ${counts.listed} listed, ${counts.not_listed} not listed.`,
        ];
        if (hits.length) lines.push(`Listed: ${hits.slice(0, 5).join(' · ')}${hits.length > 5 ? ` · and ${hits.length - 5} more` : ''}.`);
        if (settled.length) lines.push(`The list names the network: ${settled.slice(0, 5).join(', ')}${settled.length > 5 ? ', …' : ''} (an address node on each, linked from the original).`);
        if (elsewhere.length) lines.push(`The same string on another network, which is another account and not a hit: ${elsewhere.slice(0, 3).join('; ')}.`);
        if (counts.delisted) lines.push(`${plural(counts.delisted, 'address', 'addresses')} marked sanctioned earlier ${counts.delisted === 1 ? 'is' : 'are'} not on this list: written sanctioned = false. Their "listed address" links stay as a record of the earlier listing.`);
        if (counts.other_source) {
            lines.push(
                `${plural(counts.other_source, 'address', 'addresses')} already marked sanctioned without ${LIST} as sanctions_list (by hand, or from another list) ${counts.other_source === 1 ? 'was' : 'were'} left as ${counts.other_source === 1 ? 'it is' : 'they are'}: this screening answers for ${LIST} only, and a listing it found is on the "listed address" link.`,
            );
        }
        if (parties.created || counts.parties_linked) lines.push(`Listed parties: ${parties.created} new, ${plural(counts.parties_linked, 'link')} drawn or updated.`);
        const kept = keptLine(links.kept);
        if (kept) lines.push(kept);
        if (counts.skipped) lines.push(`${plural(counts.skipped, 'node')} of other types skipped.`);
        if (needCrypto) lines.push('Install the Cryptocurrency type pack in this project to create the address nodes the list names.');
        if (refused.length) lines.push(`Not written: ${refused.slice(0, 3).join('; ')}${refused.length > 3 ? ` and ${refused.length - 3} more` : ''}.`);
        if (ctx.signal?.aborted) lines.push(`Cancelled after ${counts.screened} of ${subjects.length}.`);
        for (const warning of [provenance(idx), staleness(idx)]) if (warning) lines.push(warning);
        return { summary: lines.join(' '), counts };
    },
});
