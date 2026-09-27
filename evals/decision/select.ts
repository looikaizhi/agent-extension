import { createHash } from 'node:crypto';
import { guideAgent } from '@/agent/agents/guide/agent';
import { GOALS } from '../task/goals';
import type { State } from './corpus';

/**
 * Which states become a labelled batch — picked by rule, so the same run
 * always gives the same batch.
 *
 * A run's states are mostly one kind: `guide` hops in the middle of github
 * journeys (134 of t09's 351). A batch drawn at random would be too. This one
 * is spread on purpose: every site gets an equal share, and within a site the
 * share is dealt one state at a time across the groups of (where in the
 * journey × what the model answered then), so opening hops, hops near the
 * end, and the rare answers — done, clarify, read_doc — are all in it. A site
 * that runs out passes its share on.
 *
 * Within a group, states are taken in the order of a hash of their id: fixed,
 * and blind to anything about the state.
 */

export type Position = 'opening' | 'middle' | 'end';

export interface Candidate {
  id: string;
  site: string;
  position: Position;
  /** What the model answered on this state in the run — `none` without an answer. */
  intent: string;
}

const POSITIONS: readonly Position[] = ['opening', 'middle', 'end'];

/** The answer a state recorded, read the way the product read it. */
export function recordedIntent(s: State): string {
  const o = s.answer;
  if (!o?.ok) return 'none';
  // 没有工具调用就读不出来：散文兜底那条路已经删掉，而 165 条真机语料里零命中。
  if (!o.tool) return 'unreadable';
  const p = guideAgent.parseOutput(o.tool, String(o.value));
  return p.kind === 'ok' ? p.envelope.intent : 'unreadable';
}

export function describe(states: readonly State[]): Candidate[] {
  const trip = (s: State) => `${s.run}/${s.goal}/P${s.pass}`;
  const last = new Map<string, number>();
  for (const s of states) last.set(trip(s), Math.max(last.get(trip(s)) ?? 0, s.hop));
  return states.map((s) => ({
    id: s.id,
    site: GOALS.find((g) => g.id === s.goal)?.site ?? new URL(s.context.table.url).hostname,
    position: s.hop === 0 ? 'opening' : s.hop === last.get(trip(s)) ? 'end' : 'middle',
    intent: recordedIntent(s),
  }));
}

const rank = (id: string) => createHash('sha256').update(id).digest('hex');

/** One site's groups, each in hash order, dealt from in turn. */
function dealer(cands: readonly Candidate[]): () => string | undefined {
  const key = (c: Candidate) => `${POSITIONS.indexOf(c.position)}|${c.intent}`;
  const groups = [...new Set(cands.map(key))]
    .sort()
    .map((k) =>
      cands
        .filter((c) => key(c) === k)
        .map((c) => c.id)
        .sort((a, b) => (rank(a) < rank(b) ? -1 : 1)),
    );
  let turn = 0;
  return () => {
    for (let tried = 0; tried < groups.length; tried++) {
      const g = groups[(turn + tried) % groups.length]!;
      if (g.length) {
        turn = (turn + tried + 1) % groups.length;
        return g.shift();
      }
    }
    return undefined;
  };
}

/** The ids of at most `size` states, sorted. */
export function selectBatch(cands: readonly Candidate[], size: number): string[] {
  const sites = [...new Set(cands.map((c) => c.site))].sort();
  const deal = sites.map((site) => dealer(cands.filter((c) => c.site === site)));
  const picked: string[] = [];
  const out = new Set<number>();
  for (let i = 0; picked.length < size && out.size < sites.length; i++) {
    const s = i % sites.length;
    if (out.has(s)) continue;
    const id = deal[s]!();
    if (id === undefined) out.add(s);
    else picked.push(id);
  }
  return picked.sort();
}
