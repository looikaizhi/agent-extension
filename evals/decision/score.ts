import { guideAgent } from '@/agent/agents/guide/agent';
import type { PromptTable } from '@/core/extractor/types';
import { clusterRate, clusteredWilson, passHatK, type Cluster, type Interval, type PassK } from '../stats';

/**
 * How one hop of a Decision eval is scored: did the model answer this state
 * the way the owner says it should (CONTEXT.md `Decision eval`).
 *
 * Two things carry the score: the intent — should it have pointed, stopped,
 * asked or read a document — and, for `point`, the step: the element and the
 * action.
 *
 * That check reads the state's own element table, never the product's R-a/R-e:
 * if the product's check were wrong, an eval that reused it would be wrong the
 * same way and say nothing. The answer is read with the product's own parser,
 * though — its tolerance for fenced or prose-wrapped JSON is the product's
 * real behaviour, and a stricter reader would be scoring itself.
 */

/** What a guide call can rightly answer with. */
export type GuideIntent = 'point' | 'done' | 'ask' | 'read_doc';

export interface AcceptableStep {
  ref: string;
  /** The actions that count on it — `input` on a search box, `click` on a link. */
  actions: readonly string[];
}

/** The owner's answer for one state. */
export interface Annotation {
  state: string;
  intent: GuideIntent;
  /** Required when `intent` is `point`: every step that counts. A goal
   *  on GitHub often has several ways in, so this is a set, never one answer. */
  acceptable?: readonly AcceptableStep[];
}

/** One replay's result — as much of the run loop's `RunResult` as scoring reads. */
export interface Answer {
  raw: string;
  tool?: string;
  failure?: { kind: 'transport' | 'parse' | 'violation' };
}

/**
 * - `answered`: an envelope came back and passed the product's checks;
 * - `transport`: the endpoint or the network failed and the model said nothing;
 * - `parse`: the model answered, twice, in something that is not an envelope;
 * - `violation`: a well-formed envelope the product refused, even after repair.
 */
export type Outcome = 'answered' | 'transport' | 'parse' | 'violation';

export interface Score {
  outcome: Outcome;
  /** The intent the model answered with, when it answered with one. */
  intent?: string;
  /** `null` for a transport failure — nothing was said, so nothing was right
   *  or wrong — and for a state nobody has annotated yet. */
  intentCorrect: boolean | null;
  /** When the owner's intent is `point`: the model's step, element and
   *  action judged apart. A point state answered otherwise, or not at all,
   *  has no step in the set — all three are false. `null` otherwise. */
  firstStep: { element: boolean; action: boolean; success: boolean } | null;
  /** Refs the answer points the user at — the step, every ask option,
   *  read_doc's `via_ref` — that are not on the table, or are sensitive. */
  offTable: readonly string[];
  sensitive: readonly string[];
  /** The right intent, and for `point` a successful step; `null`
   *  whenever `intentCorrect` is. */
  success: boolean | null;
}

/** Every ref an answer points the user at, read off its own fields. The Task
 *  eval counts the same refs on the answers a journey showed (`task/results.ts`). */
export function pointedAt(envelope: { intent: string } & Record<string, unknown>): string[] {
  switch (envelope.intent) {
    case 'point':
      return [envelope.ref as string];
    case 'ask':
      return (envelope.options as { ref: string }[]).map((o) => o.ref);
    case 'read_doc':
      return [envelope.via_ref as string];
    default:
      return [];
  }
}

/** Throws when the annotation itself points off this state's table, or at a
 *  sensitive control — an answer key that no answer could match. */
export function checkAnnotation(table: PromptTable, a: Annotation): void {
  if (a.intent !== 'point') return;
  if (!a.acceptable?.length) throw new RangeError(`状态 ${a.state}：意图是 point，却没有可接受的一步`);
  for (const s of a.acceptable) {
    const item = table.items.find((i) => i.ref === s.ref);
    if (!item) throw new RangeError(`状态 ${a.state}：标注里的 ${s.ref} 不在这张元素表里`);
    if (item.sensitive) throw new RangeError(`状态 ${a.state}：标注里的 ${s.ref} 是敏感控件`);
  }
}

/**
 * One answer to one state. Without an annotation — a state the owner has not
 * labelled yet — only what needs no answer key is scored: the outcome and the
 * refs the answer pointed at. Right or wrong stays `null`.
 */
export function scoreAnswer(table: PromptTable, answer: Answer, annotation?: Annotation): Score {
  if (annotation) checkAnnotation(table, annotation);
  const noStep = annotation?.intent === 'point' ? { element: false, action: false, success: false } : null;
  /** What an answer that cannot be right scores: wrong, when there is a key to be wrong against. */
  const wrong = annotation ? false : null;
  if (answer.failure?.kind === 'transport')
    return { outcome: 'transport', intentCorrect: null, firstStep: null, offTable: [], sensitive: [], success: null };

  const parsed = answer.tool ? guideAgent.parseOutput(answer.tool, answer.raw) : guideAgent.parseTextOutput(answer.raw);
  if (parsed.kind === 'error')
    return { outcome: 'parse', intentCorrect: wrong, firstStep: noStep, offTable: [], sensitive: [], success: wrong };
  const envelope = parsed.envelope as unknown as { intent: string } & Record<string, unknown>;
  const refs = pointedAt(envelope);
  const itemOf = (ref: string) => table.items.find((i) => i.ref === ref);
  const offTable = refs.filter((r) => !itemOf(r));
  const sensitive = refs.filter((r) => itemOf(r)?.sensitive);
  const where = { offTable, sensitive, intent: envelope.intent };

  // Refused by the product: the user saw no step. Counted as a failure; what
  // it pointed at is still counted above, because that is what the gate on
  // off-table and sensitive refs is for.
  if (answer.failure?.kind === 'violation')
    return { outcome: 'violation', ...where, intentCorrect: wrong, firstStep: noStep, success: wrong };

  if (!annotation) return { outcome: 'answered', ...where, intentCorrect: null, firstStep: null, success: null };
  const intentCorrect = envelope.intent === annotation.intent;
  let firstStep: Score['firstStep'] = null;
  if (annotation.intent === 'point') {
    const first = envelope.intent === 'point' ? (envelope as unknown as { ref: string; action: string }) : undefined;
    if (!first) firstStep = noStep;
    else {
      const set = annotation.acceptable!;
      const match = set.find((s) => s.ref === first.ref);
      // With the right element, the action is judged against that element's
      // own actions; with a wrong one, against every action the set accepts —
      // so "right kind of move on the wrong control" still reads as such.
      const actions = match ? match.actions : set.flatMap((s) => s.actions);
      const element = Boolean(match);
      const action = actions.includes(first.action);
      firstStep = { element, action, success: element && action };
    }
  }
  return {
    outcome: 'answered',
    ...where,
    intentCorrect,
    firstStep,
    success: intentCorrect && (firstStep === null || firstStep.success),
  };
}

/** One state, every replay of it. */
export interface StateRuns {
  state: string;
  /** Absent until the owner has labelled the state: its replays still count
   *  toward failures and toward refs pointed off the table, never toward
   *  accuracy, pass^k or stability. */
  annotation?: Annotation;
  scores: readonly Score[];
}

export interface RateWithInterval {
  rate: number;
  /** Standard error over states; `null` with fewer than two. */
  se: number | null;
  interval: Interval | null;
  /** States that entered the rate: those with at least one replay that
   *  reached the model. */
  states: number;
}

export interface Summary {
  states: number;
  /** States with the owner's annotation — the only ones the accuracies,
   *  pass^k and stability are over. */
  annotated: number;
  runs: number;
  transport: number;
  parseFailures: number;
  violations: number;
  /** Over replays that reached the model; `null` when none did. */
  parseFailureRate: number | null;
  violationRate: number | null;
  /** Replays that pointed at a ref off the table / at a sensitive control. */
  offTable: number;
  sensitive: number;
  intent: RateWithInterval | null;
  /** Over states whose right answer is `guide`; `null` when there are none. */
  firstStep: RateWithInterval | null;
  /** pass^1 … pass^k on success, one state one cluster. */
  passK: readonly PassK[];
  /** States always right, always wrong, and sometimes each. */
  stability: { alwaysRight: number; alwaysWrong: number; mixed: number };
}

function rateOf(clusters: Cluster[]): RateWithInterval | null {
  if (!clusters.length) return null;
  const { rate, se } = clusterRate(clusters);
  return { rate, se, interval: clusteredWilson(clusters), states: clusters.length };
}

/**
 * One cluster per annotated state that reached the model: its replays, and
 * how many had the intent right, the first step right (states whose right
 * answer is `guide` only), and both. What the rates below and the gate's
 * paired comparison (`gate.ts`) are computed over.
 */
export function accuracyClusters(states: readonly StateRuns[]): { intent: Cluster[]; firstStep: Cluster[]; success: Cluster[] } {
  const clusters = (pred: (s: StateRuns) => boolean, hit: (s: Score) => boolean): Cluster[] =>
    states
      .filter(pred)
      .map((s) => {
        const counted = s.scores.filter((x) => x.outcome !== 'transport');
        return { id: s.state, n: counted.length, c: counted.filter(hit).length };
      })
      .filter((k) => k.n > 0);
  const labelled = (s: StateRuns) => s.annotation !== undefined;
  return {
    intent: clusters(labelled, (s) => s.intentCorrect === true),
    firstStep: clusters((s) => s.annotation?.intent === 'point', (s) => s.firstStep?.success === true),
    success: clusters(labelled, (s) => s.success === true),
  };
}

/**
 * Every rate over states, not over replays: the k replays of one state share
 * its difficulty, so they are one cluster (`evals/stats.ts`).
 */
export function summarize(states: readonly StateRuns[]): Summary {
  const all = states.flatMap((s) => s.scores);
  const reached = all.filter((s) => s.outcome !== 'transport');
  const count = (pred: (s: Score) => boolean) => all.filter(pred).length;
  const share = (a: number, b: number) => (b ? a / b : null);

  const { intent, firstStep, success } = accuracyClusters(states);
  const maxK = Math.max(0, ...success.map((k) => k.n));
  return {
    states: states.length,
    annotated: states.filter((s) => s.annotation !== undefined).length,
    runs: all.length,
    transport: count((s) => s.outcome === 'transport'),
    parseFailures: count((s) => s.outcome === 'parse'),
    violations: count((s) => s.outcome === 'violation'),
    parseFailureRate: share(reached.filter((s) => s.outcome === 'parse').length, reached.length),
    violationRate: share(reached.filter((s) => s.outcome === 'violation').length, reached.length),
    offTable: count((s) => s.offTable.length > 0),
    sensitive: count((s) => s.sensitive.length > 0),
    intent: rateOf(intent),
    firstStep: rateOf(firstStep),
    passK: Array.from({ length: maxK }, (_, i) => passHatK(success, i + 1)),
    stability: {
      alwaysRight: success.filter((k) => k.c === k.n).length,
      alwaysWrong: success.filter((k) => k.c === 0).length,
      mixed: success.filter((k) => k.c > 0 && k.c < k.n).length,
    },
  };
}
