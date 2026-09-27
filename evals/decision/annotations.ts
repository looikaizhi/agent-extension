import { guideAgent } from '@/agent/agents/guide/agent';
import { GUIDE_STEP_ACTIONS } from '@/agent/agents/guide/output/point';
import type { State } from './corpus';
import { checkAnnotation, type Annotation, type GuideIntent } from './score';

/**
 * The owner's annotations as the labelling page stores them, back in the
 * shape scoring reads (`score.ts`) — and checked on the way in: every
 * acceptable ref on its state's own table and not a sensitive control, every
 * `point` with at least one. One bad document stops the whole pull; a half
 * pulled set of answer keys would be scored as if it were whole.
 */

const INTENTS: readonly GuideIntent[] = ['point', 'done', 'ask', 'read_doc', 'explain'];

/** The page's id for a state: `/` is not allowed in a document id. */
export const docIdOf = (state: string) => state.replace(/\//g, '~');

/** One stored document as an annotation. `read_db` may hand back the body
 *  alone or wrapped with its metadata; either is read. */
export function annotationFrom(doc: unknown): Annotation {
  const d = ((doc as { data?: unknown })?.data ?? doc) as Record<string, unknown>;
  const state = d?.state;
  if (typeof state !== 'string' || !state) throw new RangeError('标注缺 state');
  const intents = (Array.isArray(d.intents) ? d.intents : []) as GuideIntent[];
  if (!intents.length) throw new RangeError(`${state}：一个正确意图都没有`);
  for (const i of intents) if (!INTENTS.includes(i)) throw new RangeError(`${state}：意图「${String(i)}」不是 ${INTENTS.join('、')} 之一`);
  if (!intents.includes('point')) return { state, intents };
  const acceptable = Array.isArray(d.acceptable) ? d.acceptable : [];
  return {
    state,
    intents,
    acceptable: acceptable.map((a: { ref?: unknown; actions?: unknown }) => {
      const actions = Array.isArray(a?.actions) ? a.actions.map(String) : [];
      const unknown = actions.filter((x) => !(GUIDE_STEP_ACTIONS as readonly string[]).includes(x));
      if (typeof a?.ref !== 'string' || !actions.length || unknown.length)
        throw new RangeError(`${state}：可接受的一步写得不对（${JSON.stringify(a)}）`);
      return { ref: a.ref, actions };
    }),
  };
}

/**
 * Keys taken from journeys the owner judged 「到了」 (owner's choice,
 * 2026-09-15, over labelling states by hand): on each state, what the model
 * answered then — the intent, and for `point` its step.
 *
 * What such a key measures is whether a replay still walks a road known to
 * arrive, not whether a decision is right: a different step that would also
 * have arrived scores as wrong. States without a readable answer of the
 * guide's own are left out, and so is any key that fails the same check a
 * hand-made one would.
 */
export function keysFromAnswers(states: readonly State[]): { annotations: Annotation[]; skipped: { state: string; why: string }[] } {
  const annotations: Annotation[] = [];
  const skipped: { state: string; why: string }[] = [];
  for (const s of states) {
    const o = s.answer;
    if (!o?.ok) {
      skipped.push({ state: s.id, why: '当时没有回答' });
      continue;
    }
    // 没有工具调用就读不出来：散文兜底那条路已经删掉，而 165 条真机语料里
    // 零命中——记录下来的回答全都来自工具调用。
    const p = o.tool ? guideAgent.parseOutput(o.tool, String(o.value)) : ({ kind: 'error', message: '没有工具调用' } as const);
    if (p.kind !== 'ok') {
      skipped.push({ state: s.id, why: '当时的回答读不出' });
      continue;
    }
    const e = p.envelope as { intent: string; ref?: string; action?: string };
    if (!INTENTS.includes(e.intent as GuideIntent)) {
      skipped.push({ state: s.id, why: `意图 ${e.intent} 不在打分的范围里` });
      continue;
    }
    const a: Annotation =
      e.intent === 'point'
        ? { state: s.id, intents: ['point'], acceptable: [{ ref: e.ref!, actions: [e.action!] }] }
        : { state: s.id, intents: [e.intent as GuideIntent] };
    try {
      checkAnnotation(s.context.table, a);
      annotations.push(a);
    } catch (err) {
      skipped.push({ state: s.id, why: (err as Error).message });
    }
  }
  return { annotations: annotations.sort((x, y) => (x.state < y.state ? -1 : 1)), skipped };
}

/** Every document as an annotation for a state of `states`, checked against
 *  that state's table; sorted by state. Throws on the first one that is not. */
export function checkedAnnotations(docs: readonly unknown[], states: readonly State[]): Annotation[] {
  const byId = new Map(states.map((s) => [s.id, s]));
  const out = docs.map((doc) => {
    const a = annotationFrom(doc);
    const s = byId.get(a.state);
    if (!s) throw new RangeError(`${a.state}：这批语料里没有这个状态`);
    checkAnnotation(s.context.table, a);
    return a;
  });
  return out.sort((a, b) => (a.state < b.state ? -1 : 1));
}
