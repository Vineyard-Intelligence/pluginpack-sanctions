// Which listings an address node meets. Pure: the mirror's addresses.json and a node's values in,
// listings out, so test-plugin.mjs can run it against the whole list.
//
// IDENTITY IS (network, address). The Cryptocurrency type pack makes the same string on two networks
// two accounts, and the mirror keeps OFAC's listings that way: one 0x value listed under ETH, BSC and
// ARB is three records. So a node on Ethereum is listed when the ethereum record exists, and a BSC
// listing of the same string is reported beside it, not counted as a hit.
//
// ONE EXCEPTION, `evm` LISTINGS. OFAC lists some 0x values for USDT or USDC without naming a chain,
// and the mirror files those under `evm`. The listing names the address, not a chain, so it is a hit
// on that address on every EVM network; the edge says which token code it was listed under.
//
// NODES WHOSE NETWORK IS NOT ESTABLISHED (`evm`, `unknown`, and the Financial pack's legacy
// crypto_address, which has no network at all) are matched by the string. The records found on
// established networks are what the listing settles: the plugin creates those nodes and links the
// original to them, and does not rewrite the original's network (the Cryptocurrency pack's rule).
import { EVM_CHAIN_NETWORK, canonicalAddress, identityFold } from './crypto-address';
import type { Network } from './crypto-address';

export interface Listing {
    uid: number;
    code: string;
    network_from?: string;
    listed?: string;
    note?: string;
}
export interface AddressRecord {
    network: string;
    address: string;
    listings: Listing[];
}
export interface Party {
    type: 'Individual' | 'Entity' | 'Vessel' | 'Aircraft';
    name: string;
    aliases: Array<[string, 'strong' | 'weak']>;
    programs: string[];
    dates_of_birth: string[];
    places_of_birth: string[];
    nationalities: string[];
    citizenships: string[];
}
export interface AddressShard {
    format: number;
    list: string;
    as_of: string;
    addresses: AddressRecord[];
    parties: Record<string, Party>;
}

export const EVM_NETWORKS = new Set<string>(['evm', ...Object.values(EVM_CHAIN_NETWORK)]);
export const UNSETTLED = new Set<string>(['evm', 'unknown']);

export interface Match {
    /** Records with this node's own identity: the node is listed. */
    listed: AddressRecord[];
    /** For a node whose network is not established: the string's records on established networks. */
    resolved: AddressRecord[];
    /** For a node on an established network: the same string listed on other networks. */
    elsewhere: AddressRecord[];
}

const key = (network: string, address: string) => `${network}\0${address}`;

export class AddressIndex {
    private byKey = new Map<string, AddressRecord>();
    private byValue = new Map<string, AddressRecord[]>();
    readonly size: number;

    constructor(shard: AddressShard) {
        for (const rec of shard.addresses) {
            this.byKey.set(key(rec.network, rec.address), rec);
            const forms = new Set([rec.address, ...rec.listings.map((l) => (l.listed ? identityFold(l.listed) : ''))].filter(Boolean));
            for (const f of forms) {
                const list = this.byValue.get(f) ?? [];
                if (!list.includes(rec)) list.push(rec);
                this.byValue.set(f, list);
            }
        }
        this.size = shard.addresses.length;
    }

    /** Every record whose address, or value as OFAC wrote it, is one of `forms`. */
    private byForms(forms: Iterable<string>): AddressRecord[] {
        const out: AddressRecord[] = [];
        for (const f of forms) for (const r of this.byValue.get(f) ?? []) if (!out.includes(r)) out.push(r);
        return out;
    }

    /**
     * `network` is the node's (`null` for the legacy Financial type, which has none) and `raw` its
     * address as stored. The address is brought to the canonical form first: a Bitcoin Cash legacy
     * address, a Litecoin `3…` or an EIP-55 spelling on the node still meets the mirror's record.
     */
    match(network: string | null, raw: string): Match {
        const value = String(raw ?? '').trim();
        const none: Match = { listed: [], resolved: [], elsewhere: [] };
        if (!value) return none;

        if (network === null || UNSETTLED.has(network)) {
            // The string, and the re-encodings a writer would have made had it known the network.
            const forms = new Set<string>([identityFold(value)]);
            for (const n of ['bitcoin_cash', 'litecoin'] as Network[]) {
                const c = canonicalAddress(n, value);
                if (c) forms.add(identityFold(c));
            }
            let found = this.byForms(forms);
            if (network === 'evm') found = found.filter((r) => EVM_NETWORKS.has(r.network));
            const own = network ?? '\0legacy';
            return {
                listed: found.filter((r) => r.network === own),
                resolved: found.filter((r) => r.network !== own),
                elsewhere: [],
            };
        }

        const canonical = identityFold(canonicalAddress(network as Network, value) ?? value);
        const listed: AddressRecord[] = [];
        const own = this.byKey.get(key(network, canonical));
        if (own) listed.push(own);
        if (EVM_NETWORKS.has(network)) {
            const anyChain = this.byKey.get(key('evm', canonical));
            if (anyChain) listed.push(anyChain);
        }
        const elsewhere = this.byForms([canonical, identityFold(value)]).filter((r) => !listed.includes(r));
        return { listed, resolved: [], elsewhere };
    }
}

/**
 * The network a legacy Financial address's `currency` names, where it names exactly one. `eth`,
 * `bnb` and `usdt` run on several networks and `other` on any, so those stay matched by the string.
 *
 * Without this a legacy node marked `btc` met every listing of its string: 18M8bJWMzWHDBMxoLqjHHA…
 * is listed only for BCH, and a Bitcoin account written with it was marked sanctioned and linked
 * `same as` to the Bitcoin Cash node, where the same string as a `bitcoin` crypto_address is
 * correctly not a hit.
 */
const LEGACY_CURRENCY_NETWORK = new Map<string, string>([
    ['btc', 'bitcoin'],
    ['ltc', 'litecoin'],
    ['xmr', 'monero'],
    ['trx', 'tron'],
    ['sol', 'solana'],
]);
export const legacyNetwork = (currency: unknown): string | null => LEGACY_CURRENCY_NETWORK.get(String(currency ?? '').trim().toLowerCase()) ?? null;

/** A legacy node's match narrowed to the network its currency names: the rest is another account. */
export function onNetwork(m: Match, network: string): Match {
    return {
        listed: m.listed,
        resolved: m.resolved.filter((r) => r.network === network),
        elsewhere: [...m.elsewhere, ...m.resolved.filter((r) => r.network !== network)],
    };
}

/** The programmes of every entry behind these records, sorted, once each. */
export function programsOf(records: AddressRecord[], parties: Record<string, Party>): string[] {
    const out = new Set<string>();
    for (const r of records) for (const l of r.listings) for (const p of parties[String(l.uid)]?.programs ?? []) out.add(p);
    return [...out].sort();
}
