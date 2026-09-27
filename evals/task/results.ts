import { guideAgent } from '@/agent/agents/guide/agent';
import { pointedAt } from '../decision/score';
import type { LastStep, Verdict } from './arrival';

/**
 * One journey as a run's `results.json` keeps it — what the report, the
 * pairing with the next run and the owner's verdicts are made from.
 *
 * Built from the journey's log row and its model-call rows, so a run's results
 * can always be rebuilt from its raw log (`rebuild-results.mjs`) when what a
 * result carries grows, as it did when the report needed `visited`.
 */
export interface TripResult {
  pass: number;
  id: string;
  goal: string;
  endUrl: string;
  /** What was on screen when the journey stopped (`arrival.ts`). */
  lastStep: LastStep;
  programmatic: Verdict;
  hops: number;
  /** The page after each hop, in order — "reached it and walked away" is read off this. */
  visited: string[];
  calls: number;
  /** Requests the Run record charged, repair rounds included; `null` without a record. */
  requests: number | null;
  tokens: { prompt: number; completion: number; cached: number };
  ending: string | null;
  confirmation: string | null;
  /** Answers that reached the user pointing at a sensitive control — a step,
   *  a clarify option, a document link. The product refuses them, so anything
   *  but 0 is a check that failed. */
  sensitivePointed: number;
  /** The journey's last screenshot, under `raw/shots/`. */
  shot: string | null;
  crossSite?: readonly unknown[];
  instrumentFailure?: string;
}

export interface RunResults {
  run: string;
  startedAt: string;
  goals: readonly string[];
  passes: number;
  plugins: readonly string[];
  model: { baseURL: string; model: string; price?: { input: number; cached: number; output: number } };
  /** The sites the run signed into and the cookies it set there. Runs before
   *  2026-09-14 do not have it: they signed into github only, gitee anonymous
   *  and in English. */
  accounts?: readonly { host: string; cookies: readonly string[] }[];
  fingerprint: string;
  trips: TripResult[];
}

/** A journey's row in the log, as far as a result reads it. */
export interface TripRow {
  pass: number;
  id: string;
  goal: string;
  endUrl: string;
  lastStep: LastStep;
  verdict: Verdict;
  hops?: readonly { urlAfter?: string; stopped?: string }[];
  tokens?: { prompt: number; completion: number; cached: number };
  record?: { calls: number; ending: string; confirmation: string } | null;
  crossSite?: readonly unknown[];
  instrumentFailure?: string;
  shot?: string | null;
}

/** A model call's row in the log, as far as a result reads it. */
export interface CallRow {
  params: { table: { items: readonly { ref: string; sensitive?: true }[] } };
  outcome: { ok: boolean; tool?: string; value?: unknown; usage?: { prompt?: number; completion?: number; cachedPrompt?: number } } | null;
}

/** The refs a shown answer pointed the user at, read with the product's own
 *  parser — a text answer (no tool) is read the way the product read it. */
function refsOf(tool: string | undefined, value: unknown): string[] {
  // 没有工具调用就读不出来：散文兜底那条路已经删掉，而 165 条真机语料里零命中。
  if (!tool) return [];
  const parsed = guideAgent.parseOutput(tool, String(value));
  if (parsed.kind !== 'ok') return [];
  return pointedAt(parsed.envelope as unknown as { intent: string } & Record<string, unknown>);
}

function tokensOf(calls: readonly CallRow[]): TripResult['tokens'] {
  return calls.reduce(
    (t, c) => {
      const u = c.outcome?.usage;
      return u ? { prompt: t.prompt + (u.prompt ?? 0), completion: t.completion + (u.completion ?? 0), cached: t.cached + (u.cachedPrompt ?? 0) } : t;
    },
    { prompt: 0, completion: 0, cached: 0 },
  );
}

export function resultOf(trip: TripRow, calls: readonly CallRow[], shot: string | null = trip.shot ?? null): TripResult {
  const sensitivePointed = calls.filter((c) => {
    if (!c.outcome?.ok) return false;
    const sensitive = new Set(c.params.table.items.filter((i) => i.sensitive).map((i) => i.ref));
    return refsOf(c.outcome.tool, c.outcome.value).some((r) => sensitive.has(r));
  }).length;
  return {
    pass: trip.pass,
    id: trip.id,
    goal: trip.goal,
    endUrl: trip.endUrl,
    lastStep: trip.lastStep,
    programmatic: trip.verdict,
    hops: trip.hops?.length ?? 0,
    visited: (trip.hops ?? []).map((h) => h.urlAfter).filter((u): u is string => typeof u === 'string'),
    calls: calls.length,
    requests: trip.record?.calls ?? null,
    tokens: trip.tokens ?? tokensOf(calls),
    ending: trip.record?.ending ?? null,
    confirmation: trip.record?.confirmation ?? null,
    sensitivePointed,
    shot,
    ...(trip.crossSite ? { crossSite: trip.crossSite } : {}),
    ...(trip.instrumentFailure ? { instrumentFailure: trip.instrumentFailure } : {}),
  };
}
