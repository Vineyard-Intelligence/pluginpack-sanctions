// Edges, written the way the Cryptocurrency pack's rules ask of every collector.
//
// A pair of nodes has one edge (the backend's unique key), and `createEdge` on a linked pair under
// another label proposes RELABELLING it. So the edge list is read first (`edge:read`): a pair that is
// already linked keeps its label and gets this pack's data keys added, a pair linked under this
// label gets only the keys that changed, and a pair with nothing new is left alone, so a re-run on an
// unchanged list stages nothing.
//
// WHEN THE HOST DOES NOT SHOW AN EDGE'S DATA. The app hands plugins a copy of each link's data
// (host-bridge.ts `toEdge`, frontend main 2026-11-16), so a re-run compares the keys and refreshes
// a link from a newer list. Older versions of the app handed id, endpoints and label only (checked
// 2026-11-15). Read as "no keys", every existing link looked changed, and a re-run on an unchanged
// list staged an update for each of them with all of its keys: a review full of rows that change
// nothing. An edge with no `data` property is therefore one whose keys this run cannot see, and it
// is left as it is: it keeps what an earlier run wrote, and this run's keys are not added to it.
// `kept` counts them, so the summary can say the links were not compared. An edge that carries
// `data`, even `{}`, has its keys compared as above.
import type { GraphEdge, HostContext } from './sdk';

export type LinkResult = 'created' | 'updated' | 'unchanged' | 'kept' | 'refused';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class Links {
    private ctx: HostContext;
    private pairs: Map<string, GraphEdge> | null = null;
    private done = new Map<string, LinkResult>();
    created = 0;
    updated = 0;
    /** Existing links left as they are because the host did not show their data. */
    kept = 0;
    refused: string[] = [];

    constructor(ctx: HostContext) {
        this.ctx = ctx;
    }

    private async existing(): Promise<Map<string, GraphEdge>> {
        if (this.pairs) return this.pairs;
        const out = new Map<string, GraphEdge>();
        try {
            for (const e of (await this.ctx.graph?.edges?.()) ?? []) out.set(`${e.from_node_id}\0${e.to_node_id}`, e);
        } catch {
            /* unreadable: every link is proposed as new, and the host still turns a duplicate into an update */
        }
        this.pairs = out;
        return out;
    }

    /**
     * Link `from` → `to`. One write per pair per run: the first call for a pair decides it, so a
     * caller gathers everything a pair should carry before calling. A later call for the pair wrote
     * nothing and says 'unchanged' (or 'refused' again), so it is not counted as a link drawn.
     */
    async link(from: string, to: string, label: string, data: Record<string, unknown>): Promise<LinkResult> {
        const key = `${from}\0${to}`;
        const prior = this.done.get(key);
        if (prior) return prior === 'refused' ? prior : 'unchanged';
        let result: LinkResult;
        try {
            const edge = (await this.existing()).get(key);
            if (!edge) {
                await this.ctx.graph!.createEdge!({ from, to, label, data });
                this.created++;
                result = 'created';
            } else if (edge.data === undefined || edge.data === null) {
                this.kept++;
                result = 'kept';
            } else {
                const changed: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(data)) if (!same(edge.data[k], v)) changed[k] = v;
                if (!Object.keys(changed).length) {
                    result = 'unchanged';
                } else {
                    // By the edge's id and without a label, so its wording and grade stay as they are.
                    await this.ctx.graph!.updateEdge!(String(edge.id), { data: changed });
                    this.updated++;
                    result = 'updated';
                }
            }
        } catch (e) {
            this.refused.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
            result = 'refused';
        }
        this.done.set(key, result);
        return result;
    }
}

/** One summary line for links left unread, or ''. */
export function keptLine(kept: number): string {
    if (!kept) return '';
    return `${kept === 1 ? '1 existing link was' : `${kept} existing links were`} left as ${kept === 1 ? 'it is' : 'they are'}: this run was not given ${kept === 1 ? 'its' : 'their'} data (an older Vineyard does not pass a link's data to plugins), so ${kept === 1 ? 'its keys were' : 'their keys were'} not compared with this list.`;
}
