# Sanctions Screening — a Vineyard plugin pack

Screens crypto addresses, people and organizations against OFAC's Specially Designated Nationals
list (SDN). Addresses are matched exactly, on their own network. Names are matched by similarity and
staged as possible matches with a score. No account, no key, and nothing screened leaves the device.

The list comes from [sanctions-mirror](https://github.com/Vineyard-Intelligence/sanctions-mirror),
which rebuilds OFAC's `SDN.XML` every six hours, checked against OFAC's own digest, as JSON a page
can read. OFAC's file cannot be fetched from a browser: its 302 allows any origin, but the S3
pre-signed URL behind it sends no CORS header (measured 2026-11-14). A run downloads `index.json`
and the whole shard it needs at the path that index names for it, `data/<sha256>.json`, checks the
bytes against that SHA-256, and matches locally: GitHub sees that a screening happened, not what
was screened. The content path is what keeps a run on one build: raw.githubusercontent.com caches
each path for five minutes and leaves the query string out of its cache key (measured
2026-11-15), so right after an update a `?v=` could not tell the index of one build from a shard
of the next. A shard that does not match its index fails the run before anything is staged.

## Plugins

### OFAC Address Screening (`run.vineyard.plugins.sanctions_address_screening`)

Takes `cryptocurrency.crypto_address` nodes. A node of the Financial pack's legacy
`financial.crypto_address`, which Financial 3.0.0 removed, is no longer a declared input, so the run
panel does not offer the plugin on one: Chain Explorer's Identify Crypto Network links it to a
Cryptocurrency pack address first. Handed one all the same, the plugin screens it as below.

On every screened address it writes the Cryptocurrency type pack's fields:

| Field | Value |
| --- | --- |
| `sanctioned` | `true` when the list names the address on its network, `false` when it does not |
| `sanctions_list` | `OFAC SDN`, the list the answer is for |
| `sanctions_programs` | the programmes of every entry that lists it (`CYBER2`, `DPRK3`, …); `[]` when an earlier list's are gone |
| `sanctions_as_of` | the publish date of the list it was screened against |

For a listed address, the entry becomes a node — `identity.person` for an individual,
`identity.organization` for an entity — linked to the address by **`listed address`**:

| Key | Example |
| --- | --- |
| `list` | `OFAC SDN` |
| `uid` | `45404`, the SDN entry |
| `program` | `["ILLICIT-DRUGS-EO14059"]`, the entry's programmes |
| `listed_as` | `["XBT"]`, the codes OFAC lists the address under |
| `listed` | the value as OFAC wrote it, when the canonical form differs (an EIP-55 spelling, a legacy BCH address) |
| `as_of` | the list's publish date |

Matching follows the Cryptocurrency pack's identity, `(network, address)`:

- **The same string on another network is another account.** A node on Ethereum is listed when the
  list names the address for ETH; a BSC listing of the same `0x…` is named in the run summary and
  not counted.
- **USDT and USDC on `0x…` values name no chain.** The mirror files them under `evm`, and such a
  listing is a hit on that address on every EVM network; `listed_as` says which token it was.
- **An address whose network is not established** — `evm`, `unknown`, or the legacy Financial
  type — is settled by the list: each network the list names the string on gets its own address
  node, linked from the original by **`same address on`** (from the legacy type, **`same as`**),
  with `basis` saying which listing decided it. The original keeps its network; its own
  `sanctioned` says whether the string is listed at all.
- **A legacy address whose `currency` names one chain** (`btc`, `ltc`, `xmr`, `trx`, `sol`) is
  screened on that chain only, and a listing of its string on another network is named, not
  counted. `eth`, `bnb`, `usdt` and `other` name no single network, so those are settled as above.
- The node's address is brought to canonical form first, so an EIP-55 spelling or a Bitcoin Cash
  legacy address still meets the mirror's record. The node itself is not rewritten.

`false` is written, not left out: it is the screening's answer, and it is how a delisting reaches a
node an earlier list marked (Tornado Cash came off the list on 2025-03-21). The `listed address`
edge stays as a record of the earlier listing.

Only its own answer is rewritten. The type pack's `sanctioned` means "on a sanctions list", any
list, so an address already marked `sanctioned: true` with no `sanctions_list`, or another list's
(by hand, from an EU or UK designation), keeps its fields: OFAC not listing it does not refute the
other list. The summary counts such addresses, and an OFAC listing of one is still drawn as its
`listed address` link. The same holds for an address node the list settles that the project
already has.

### OFAC Name Screening (`run.vineyard.plugins.sanctions_name_screening`)

Takes `identity.person` nodes, screened against the list's individuals, and `identity.organization`
nodes, screened against its entities, by their name and `aliases`.

Each entry whose name scores at least **Min score** becomes a party node, as above, linked from the
subject by **`possible sanctions match`**:

| Key | Example |
| --- | --- |
| `score` | `0.97`, rounded down |
| `subject_name`, `listed_name` | the two names that met |
| `matched_on` | `name`, `strong alias` or `weak alias` |
| `list`, `uid`, `program`, `as_of` | as above |
| `min_score` | the run's Min score |
| `date_of_birth_check` | `same date`, `same year` or `different year`, when the subject has a `date_of_birth` |

The subject gets only `sanctions_screened_as_of` and `sanctions_screened_min_score`, so "no
candidate" is told from "never screened". Nothing marks it sanctioned: a name match is a candidate
to confirm or dismiss, not a finding. A selected party node (one with `sanctions_uid`) is re-checked
by uid instead, and written `sanctioned: false` when its entry is gone.

| Parameter | Default | |
| --- | --- | --- |
| Min score (`min_score`) | 0.85 | 0.75–1. 1 is the same words in any order |
| Max candidates (`max_candidates`) | 3 | 1–10 per node, best first |
| Include weak aliases (`include_weak_aliases`) | off | aliases OFAC marks too broad to identify anyone by themselves |

How a score is made is written out in `src/names.ts`: words are matched by Jaro-Winkler at 0.90 or
more, the subject's words weigh most, word order does not matter, and two words may be read as one
on either side ("Alqaida" reaches `AL QA'IDA`, "Kim Jongun" `KIM, Jong Un`). Titles and legal forms
(`LLC`, `OOO`, `Ltd`, …) are dropped.
On the 2026-11-13 list "Kim Jong Un", "Kim Jong-un", "Jong Un Kim" and "Kim Jongun" reach
`KIM, Jong Un` at 1.00, `KIM, Jong Man` scores 0.73, and "Viktor Bout" reaches
`BOUT, Viktor Anatolijevitch` at 0.88. Names in a script other than Latin meet nothing; screen a
romanized alias.

## Party nodes

One node per SDN entry, labelled with its uid: `KIM, Yong Chol (OFAC SDN 12211)`. Identity's person
and organization are identified by name alone, and the list itself has 24 names held by more than
one entry — two people called `KIM, Yong Chol`, two `MINISTRY OF STATE SECURITY` — so the uid keeps
them apart, and keeps a listed party from merging with the analyst's own node for the person under
investigation. A new party node carries the name as OFAC writes it and its strong aliases in
`aliases`, a single exact `date_of_birth` (otherwise `listed_dates_of_birth`), `nationality`,
`listed_places_of_birth`, and `sanctioned`, `sanctions_list`, `sanctions_uid`, `sanctions_programs`
and `sanctions_as_of`. An existing one is reused: only its sanctions fields follow the list.

## Edges

A pair of nodes has one edge. A pair already linked keeps its label and gets these keys added; a
pair with nothing new is left alone, so a re-run on an unchanged list stages nothing.

That needs the edge's data, which the app hands plugins as a copy (`toEdge` in `host-bridge.ts`), so
a re-run on a newer list refreshes only the keys that changed on each existing link. Older versions
of the app handed id, endpoints and label only: read as "no keys", every existing link looked
changed and a re-run staged an update for each. So an existing edge that comes without `data` is
left as it is, keeping what an earlier run wrote, and the summary says how many were not compared.
On such an app its keys are not refreshed from a newer list; the address and party fields still
are.

## Type packs

`run.vineyard.typepacks.cryptocurrency` 1.0.0 declares the address fields, and
`run.vineyard.typepacks.identity` the person and organization. `sanctions_*` and `listed_*` on a party
node, and on a legacy Financial address, are undeclared fields. In a project without the
Cryptocurrency type pack, the address nodes the list would settle are not created, and the summary
says to install it.

## Building from source

`src/` is the source of `dist/pack.mjs`; there are no dependencies. esbuild is pinned, so the
published bundle can be checked:

```bash
node build.mjs && node gen-manifest.mjs
git diff --exit-code dist/pack.mjs plugins/
node test-plugin.mjs
SANCTIONS_MIRROR=../sanctions-mirror node test-plugin.mjs    # also against the whole list
npx -p typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

`test-plugin.mjs` runs the bundle against an in-memory graph that validates and de-duplicates the
way the app does, and a mirror served from disk. `test-fixtures/mirror` is what sanctions-mirror's
build makes of its `test/fixture-sdn.xml`, 26 real entries from the 2026-11-13 list; the command is
at the top of `test-plugin.mjs`. `test-fixtures/types` holds the three type definitions, compared
with the type packs when they are checked out beside this repository; the legacy address is compared
with Financial 2.0.0, the last release that defined it. The manifest's types are checked against
the type packs beside this repository too, as the registry checks them.

`src/sdk.ts` and `src/crypto-address.ts` are copies: the first of the plugin SDK, the second of the
address code every pack that writes crypto addresses carries (and sanctions-mirror too, so both
agree on the canonical form). A fix to either does not reach the other copies by itself.

The mirror's format is checked (`format: 1`); a mirror in a newer format fails the run with a request
to update the pack.

## License

Apache-2.0, see `LICENSE`. The SDN list is a work of the U.S. Government and not subject to
copyright in the United States.
