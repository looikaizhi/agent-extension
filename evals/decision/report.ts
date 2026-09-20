import type { PromptTable } from '@/core/extractor/types';
import { costOf, type Price } from '../options';
import type { Replay } from './replay';
import { scoreAnswer, summarize, type Annotation, type StateRuns, type Summary } from './score';

/**
 * Every number `eval:decision` reports for one run, computed from the replays
 * alone — so a result file can be read again, or scored against annotations
 * made after it, without asking the model anything.
 */
export interface DecisionReport {
  summary: Summary;
  /** The answers by intent; `unreadable` for a parse failure. Network errors are not answers. */
  intents: Record<string, number>;
  tokens: { prompt: number; completion: number; cached: number };
  /** `null` without prices. */
  cost: number | null;
  /** Per answer that reached the model, nearest rank; `null` when none did. */
  latency: { medianMs: number; p90Ms: number } | null;
  /** Answers for which the endpoint had to be asked again. */
  retried: number;
  /** Annotations for states this run did not answer. */
  unknownAnnotations: string[];
}

const rank = (sorted: readonly number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

/** Every state's answers, scored against its own table and — when it has one — its annotation. */
export function stateRunsOf(
  tables: ReadonlyMap<string, PromptTable>,
  replays: readonly Replay[],
  annotations: readonly Annotation[],
): StateRuns[] {
  const keyOf = new Map(annotations.map((a) => [a.state, a]));
  return [...tables].map(([state, table]) => {
    const annotation = keyOf.get(state);
    const scores = replays.filter((r) => r.state === state).map((r) => scoreAnswer(table, r, annotation));
    return { state, ...(annotation ? { annotation } : {}), scores };
  });
}

export function decisionReport({
  tables,
  replays,
  annotations,
  price,
}: {
  /** Every state this run answered, by id, in report order. */
  tables: ReadonlyMap<string, PromptTable>;
  replays: readonly Replay[];
  annotations: readonly Annotation[];
  price?: Price;
}): DecisionReport {
  const runs = stateRunsOf(tables, replays, annotations);

  const intents: Record<string, number> = {};
  for (const s of runs.flatMap((r) => r.scores)) {
    if (s.outcome === 'transport') continue;
    const k = s.intent ?? 'unreadable';
    intents[k] = (intents[k] ?? 0) + 1;
  }

  const tokens = replays.reduce(
    (t, r) =>
      r.usage
        ? { prompt: t.prompt + r.usage.prompt, completion: t.completion + r.usage.completion, cached: t.cached + (r.usage.cachedPrompt ?? 0) }
        : t,
    { prompt: 0, completion: 0, cached: 0 },
  );
  const ms = replays
    .filter((r) => r.failure?.kind !== 'transport')
    .map((r) => r.ms)
    .sort((a, b) => a - b);

  return {
    summary: summarize(runs),
    intents,
    tokens,
    cost: costOf(tokens, price),
    latency: ms.length ? { medianMs: rank(ms, 0.5), p90Ms: rank(ms, 0.9) } : null,
    retried: replays.filter((r) => r.attempts > 1).length,
    unknownAnnotations: annotations.filter((a) => !tables.has(a.state)).map((a) => a.state),
  };
}
