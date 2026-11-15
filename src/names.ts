// Name similarity for screening, and nothing that decides identity. Pure, so test-plugin.mjs runs it
// against the whole list.
//
// WHAT A SCORE IS: how much of the subject's name the listed name covers, from 0 to 1, independent
// of word order. Two words agree when they are equal, or when both have three letters or more, about
// the same length, and a Jaro-Winkler similarity of at least 0.90 ("Mingming" and "Mingjing", "Yong"
// and "Myong"). Below that a pair counts for nothing: Jaro-Winkler gives any two short words that
// share a letter about 0.5, and counting that carried "Kim" alone to "KIM, Ki Nam" at 0.89.
//
//   q  the share of the subject's letters in words the listed name agrees with
//   c  the same, the other way round
//   score = q × (0.8 + 0.2 c)       when the subject has two words or more
//   score = q × c                   when it has one
//
// The subject's words are what is looked for, so they decide most of it: OFAC writes middle names
// and patronymics a subject often lacks ("Viktor Bout" is "BOUT, Viktor Anatolijevitch", 0.88), and
// those cost at most a fifth. One word is not a name, so "Kim" alone reaches only a listed "KIM".
// Two neighbouring words may be read as one where the other name has the joined word ("Jongun",
// "Alzawahiri").
//
// Measured on the 2026-11-13 list (test-plugin.mjs keeps these): "Kim Jong Un", "Kim Jong-un",
// "Kim Jongun" and "Jong Un Kim" reach "KIM, Jong Un" at 1.00 and "KIM, Jong Man" at 0.73; "Park
// Jin Hyok" reaches "RI, Jin Hyok" at 0.61; "Kim" reaches "KIM, Ki Nam" at 0.38.
//
// Before comparison: Latin letters lose their accents, case is folded, punctuation is a word break
// (the apostrophes of McCune-Reischauer go, so "Ch'in-hyo'k" reads "chin hyok"), doubled letters are
// one ("Mohammed" and "Mohamed"), and titles (Dr, Haji, Mullah…) and, for organisations, legal forms
// (LLC, Ltd, OOO, JSC…) are dropped. Scripts other than Latin are compared as written: the list is in
// Latin script, so a name in Hangul or Cyrillic meets nothing, and the summary says so.
//
// A HIGH SCORE IS A CANDIDATE. Names collide — the 2026-11-13 list itself has two people called
// "KIM, Yong Chol" — and spellings vary, so a match is staged as a possible match for the analyst to
// confirm or dismiss against date of birth, nationality and the listing itself.

const TITLES = new Set([
    'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'haji', 'hajji', 'hadji', 'alhaji', 'mullah', 'mulla', 'sheikh', 'shaykh',
    'shaikh', 'sheik', 'maulavi', 'maulvi', 'mawlawi', 'maulawi', 'maulana', 'qari',
]);
const LEGAL_FORMS = new Set([
    'llc', 'ltd', 'limited', 'co', 'company', 'inc', 'incorporated', 'corp', 'corporation', 'plc', 'lp', 'llp', 'jsc', 'ojsc', 'cjsc', 'pjsc',
    'ooo', 'oao', 'zao', 'pao', 'ao', 'tov', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv', 'ab', 'oy', 'ou', 'as', 'kft',
    'pte', 'pvt', 'sdn', 'bhd', 'fze', 'fzco', 'fzc', 'fzllc', 'ltda', 'sro', 'the', 'and', 'of',
]);

export type NameKind = 'person' | 'org';

/** Whether `s` has a letter outside the Latin script. */
export const nonLatin = (s: string): boolean => /[^\p{Script=Latin}\P{L}]/u.test(s);

/** The words a name is compared by. */
export function tokens(name: string, kind: NameKind): string[] {
    const plain = String(name ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/['’‘`ʼ]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    if (!plain) return [];
    const words = plain.split(' ');
    const drop = kind === 'org' ? LEGAL_FORMS : TITLES;
    const kept = words.filter((w) => !drop.has(w));
    // Doubled letters become one only after titles and legal forms are dropped. Collapsed first,
    // "LLC" read "lc", "OOO" "o" and "Mullah" "mulah", none of which was dropped, and "Garantex LLC"
    // scored 0.80 against GARANTEX, under the default Min score.
    return (kept.length ? kept : words).map((w) => w.replace(/(\p{L})\1+/gu, '$1'));
}

/** Jaro-Winkler similarity (prefix weight 0.1, up to four letters). */
export function jaroWinkler(a: string, b: string): number {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    if (!la || !lb) return 0;
    const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
    const ma = new Uint8Array(la);
    const mb = new Uint8Array(lb);
    let m = 0;
    for (let i = 0; i < la; i++) {
        const lo = Math.max(0, i - range);
        const hi = Math.min(lb - 1, i + range);
        for (let j = lo; j <= hi; j++) {
            if (mb[j] || a.charCodeAt(i) !== b.charCodeAt(j)) continue;
            ma[i] = 1;
            mb[j] = 1;
            m++;
            break;
        }
    }
    if (!m) return 0;
    let t = 0;
    for (let i = 0, j = 0; i < la; i++) {
        if (!ma[i]) continue;
        while (!mb[j]) j++;
        if (a.charCodeAt(i) !== b.charCodeAt(j)) t++;
        j++;
    }
    const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
    let p = 0;
    while (p < 4 && p < la && p < lb && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    return jaro + p * 0.1 * (1 - jaro);
}

/**
 * The words as given, and with one pair of neighbours read as one word — only where that word is
 * one of `other`'s, as written. Joining is for "Jong Un" against "Jongun"; compared loosely it
 * matched "jongun" to "jongman" at 0.91 on their shared "jong" and put "KIM, Jong Man" at 0.93
 * against "Kim Jong Un".
 */
export function variants(words: string[], other: string[]): string[][] {
    const out = [words];
    const there = new Set(other);
    for (let i = 0; i + 1 < words.length; i++) {
        const joined = words[i] + words[i + 1];
        if (there.has(joined)) out.push([...words.slice(0, i), joined, ...words.slice(i + 2)]);
    }
    return out;
}

/**
 * Whether two words agree, and how closely: 1 when equal; the Jaro-Winkler similarity when it is at
 * least TOKEN_MATCH, both words have three letters or more and their lengths differ by at most one
 * (a quarter of the shorter, past eight letters); else 0.
 *
 * The length rule is there because Jaro-Winkler rewards a shared start: "jong" and "jongun" are
 * 0.93, which read "Kim Jongun" as "KIM, Yo Jong" at 0.91.
 */
export const TOKEN_MATCH = 0.9;
export function wordScore(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return 0;
    if (Math.abs(a.length - b.length) > Math.max(1, Math.floor(Math.min(a.length, b.length) / 4))) return 0;
    const s = jaroWinkler(a, b);
    return s >= TOKEN_MATCH ? s : 0;
}

/** The share of `from`'s letters in words `to` agrees with, each weighted by its closest match. */
export function coverage(from: string[], to: string[]): number {
    let got = 0;
    let weight = 0;
    for (const w of from) {
        let best = 0;
        for (const v of to) {
            const s = wordScore(w, v);
            if (s > best) best = s;
            if (best === 1) break;
        }
        got += best * w.length;
        weight += w.length;
    }
    return weight ? got / weight : 0;
}

/** The score of one reading of the subject's name against one reading of a listed name. */
export function pairScore(subject: string[], listed: string[]): number {
    if (!subject.length || !listed.length) return 0;
    const q = coverage(subject, listed);
    if (!q) return 0;
    const c = coverage(listed, subject);
    return subject.length > 1 ? q * (0.8 + 0.2 * c) : q * c;
}

/** The best score over both names' readings. The subject's word count is the one it was written
 *  with: reading two of its words as one does not make it a one-word name. */
export function nameScore(subject: string[], listed: string[]): number {
    let best = 0;
    for (const x of variants(subject, listed)) {
        for (const y of variants(listed, subject)) {
            let s = pairScore(x, y);
            if (subject.length > 1 && x.length === 1) s = coverage(x, y) * (0.8 + 0.2 * coverage(y, x));
            if (s > best) best = s;
            if (best === 1) return 1;
        }
    }
    return best;
}

/** One name on the list: the entry's own name or one of its aliases. */
export interface ListedName {
    uid: number;
    text: string;
    words: string[];
    via: 'name' | 'strong alias' | 'weak alias';
}

export interface Candidate {
    uid: number;
    score: number;
    listedName: string;
    via: ListedName['via'];
    subjectName: string;
}


/**
 * Screening against one shard. Built once per run: every listed name is reduced to words, and an
 * index from each word to the names that hold it limits scoring to names that share an agreeing
 * word with the subject — a name with none scores 0. Agreeing words are found by comparing against
 * the shard's vocabulary once per distinct subject word.
 *
 * A JOIN ON EITHER SIDE. nameScore reads two neighbouring words as one on whichever side the joined
 * word is written whole on the other (variants), so the index has to reach both. The subject's joins
 * are probed against the vocabulary. The listed names' joins are indexed too (`byJoin`, exact,
 * because variants joins only on an exact match): before they were, a one-word subject that is a
 * listed name run together — "Alqaida" for AL QA'IDA, "Hydramarket" for HYDRA MARKET — scored 1.00
 * against the name and never reached it, so the screening reported nothing.
 */
export class NameMatcher {
    private names: ListedName[] = [];
    private byWord = new Map<string, number[]>();
    private byJoin = new Map<string, number[]>();
    private vocabulary: string[] = [];
    private near = new Map<string, string[]>();
    private kind: NameKind;

    constructor(rows: Array<[number, string, Array<[string, 'strong' | 'weak']>, ...unknown[]]>, kind: NameKind, includeWeak: boolean) {
        this.kind = kind;
        for (const row of rows) {
            const [uid, name, aliases] = row;
            this.add(uid, name, 'name');
            for (const [alias, category] of aliases ?? []) {
                if (category === 'weak' && !includeWeak) continue;
                this.add(uid, alias, category === 'weak' ? 'weak alias' : 'strong alias');
            }
        }
        this.vocabulary = [...this.byWord.keys()];
    }

    private add(uid: number, text: string, via: ListedName['via']) {
        const words = tokens(text, this.kind);
        if (!words.length) return;
        const i = this.names.length;
        this.names.push({ uid, text, words, via });
        const put = (map: Map<string, number[]>, w: string) => {
            const list = map.get(w);
            if (!list) map.set(w, [i]);
            else if (list[list.length - 1] !== i) list.push(i);
        };
        for (const w of words) put(this.byWord, w);
        for (let k = 0; k + 1 < words.length; k++) put(this.byJoin, words[k] + words[k + 1]);
    }

    get size(): number {
        return this.names.length;
    }

    private closeWords(word: string): string[] {
        let hit = this.near.get(word);
        if (!hit) {
            hit = this.vocabulary.filter((v) => wordScore(word, v) > 0);
            this.near.set(word, hit);
        }
        return hit;
    }

    /**
     * The entries whose best-scoring name reaches `minScore` against any of `subjectNames`, best
     * first, at most `limit`. One candidate per entry: its best name, and which subject name met it.
     */
    screen(subjectNames: string[], minScore: number, limit: number): Candidate[] {
        const best = new Map<number, Candidate>();
        for (const subjectName of subjectNames) {
            const words = tokens(subjectName, this.kind);
            if (!words.length) continue;
            const pool = new Set<number>();
            // Every name a reading could score shares an agreeing word with it: a subject word or
            // join close to a listed word, or a subject word that is a listed name's join.
            const probe = new Set(words);
            for (let k = 0; k + 1 < words.length; k++) probe.add(words[k] + words[k + 1]);
            for (const w of probe) for (const v of this.closeWords(w)) for (const i of this.byWord.get(v) ?? []) pool.add(i);
            for (const w of words) for (const i of this.byJoin.get(w) ?? []) pool.add(i);
            for (const i of pool) {
                const n = this.names[i];
                const score = nameScore(words, n.words);
                if (score < minScore) continue;
                const prior = best.get(n.uid);
                // The entry's own name wins a tie with an alias: it is what the list calls them.
                if (!prior || score > prior.score || (score === prior.score && n.via === 'name' && prior.via !== 'name')) {
                    best.set(n.uid, { uid: n.uid, score, listedName: n.text, via: n.via, subjectName });
                }
            }
        }
        return [...best.values()].sort((a, b) => b.score - a.score || a.uid - b.uid).slice(0, limit);
    }
}

/** Two decimals, rounded down, so 0.8799 is never shown as passing 0.88. */
export const shownScore = (s: number): number => Math.floor(s * 100 + 1e-9) / 100;
