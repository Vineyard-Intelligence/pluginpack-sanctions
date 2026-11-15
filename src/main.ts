// Sanctions Screening — OFAC's SDN list, for addresses and for names.
//
// Two plugins over one list, read from the sanctions mirror (mirror.ts says why there is a mirror):
//   address-screening.ts  exact matches on (network, address), written as the Cryptocurrency type
//                         pack's sanctioned fields and `listed address` edges
//   name-screening.ts     scored name similarity, staged as `possible sanctions match` candidates
//
// Graph writes are STAGED: nothing reaches the project until the analyst reviews and applies it.
import { definePluginPack } from './sdk';
import type { PluginManifest, VineyardPluginPack } from './sdk';
import { AUTHOR, LICENSE, PLATFORMS } from './common';
import { addressScreening } from './address-screening';
import { nameScreening } from './name-screening';

// The pack's page in the catalog, in Markdown: the About section below the one-line `summary`. The
// plugins and their permissions are listed right below it, so the page says only what that list
// does not. Lines in an array so the Markdown's backticks need no escaping.
const PAGE = [
    "For the sanctions question in a crypto or financial case: is this address, person or company on OFAC's SDN list? Addresses match exactly, on their own network, and are linked to the party the list names. Names match by similarity, as scored candidates to confirm or dismiss.",
    '',
    '**Needs:** nothing. No account and no key.',
    '',
    '**Who sees it:** GitHub, which serves the list. A run downloads the whole list and matches on this device, so nothing you screen is sent anywhere. OFAC is not contacted.',
    '',
    '**Read results with care:**',
    '',
    '- The same string on another network is another account: the run names it and does not count it as a hit. A value OFAC lists for USDT or USDC without a chain matches on every EVM network.',
    "- `sanctioned: false` means not on the SDN list as of `sanctions_as_of`. It says nothing about other lists (UN, EU, UK, Korea) or about who controls the address. An address already marked sanctioned keeps that mark.",
    '- A possible match is a similar name, not the same party: compare date of birth and nationality before treating it as yours.',
    "- The mirror checks OFAC every six hours; a run warns when it has not for three days. Confirm a hit on OFAC's Sanctions List Search (https://sanctionssearch.ofac.treas.gov/) before acting on it.",
    '',
    "**Data and licences:** OFAC's SDN list, a U.S. Government work, as rebuilt and checked by sanctions-mirror (https://github.com/Vineyard-Intelligence/sanctions-mirror).",
    '',
    '**Source:** https://github.com/Vineyard-Intelligence/pluginpack-sanctions (Apache-2.0)',
].join('\n');

const pack: VineyardPluginPack & {
    author: { name: string; url: string };
    license: string;
    icon: string;
    platforms: PluginManifest['platforms'];
} = {
    identifier: 'run.vineyard.pluginpacks.sanctions',
    content_type: 'vineyard:pluginpack',
    name: 'Sanctions Screening',
    version: '1.0.0',
    summary:
        "Screens crypto addresses, people and organizations against OFAC's SDN list: exact address matches on each address's own network, and scored possible matches for names. The list is downloaded whole and matched on this device.",
    description: PAGE,
    author: AUTHOR,
    license: LICENSE,
    icon: 'shield-ban',
    platforms: PLATFORMS,
    plugins: [addressScreening, nameScreening],
};

export const sanctionsPack = definePluginPack(pack);
export default sanctionsPack;

// For test-plugin.mjs, which runs the pure parts against the whole list. The host reads only the
// default export.
export { AddressIndex, programsOf } from './address-match';
export { NameMatcher, nameScore, tokens, wordScore, jaroWinkler, shownScore } from './names';
export { checkIndex, dataPath, provenance, staleness, sha256Hex, MIRROR } from './mirror';
export { dateOfBirthCheck, exactDate, partyData, partyLabel } from './parties';
export { canonicalAddress, identityFold } from './crypto-address';
