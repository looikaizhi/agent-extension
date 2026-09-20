import { guideAgent, type GuideContext } from '@/agent/agents/guide/agent';
import { contributionsFor, pluginsNamed } from '@/agent/context/plugins';
import type { GuideHistory } from '@/agent/context/user-message';
import type { CallModelParams, EffectOutcome } from '@/agent/thread/effect';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref, Trace } from '@/shared/types';

/**
 * The Decision eval's corpus: states, one model call each, taken apart from
 * Task eval logs (CONTEXT.md `Decision eval`).
 *
 * A state keeps its call twice. Once as structured Context — goal, element
 * table, history, fresh refs, and the run's Plugins — because a replay has to
 * be able to switch a Plugin off, and a Skill's paragraph lives inside the
 * user message, where raw text cannot lose it. And once as the bytes the model
 * actually read, which is what proves a replay is the same call: rebuilt
 * through today's code, the structured half must give the recorded half back
 * byte for byte, the table wrapper's random marker aside.
 */

/** The wrapper around the element table carries a random marker (S-01).
 *  Pinned to one value on both sides, so everything else can be compared. */
const NONCE = '00000000-0000-4000-8000-000000000000';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const pin = (s: string) => s.replace(UUID, NONCE);

export interface State {
  /** `<run>/<goal>/P<pass>/<seq>` — unique across runs. */
  id: string;
  run: string;
  /** The goal's id in `evals/task/goals.ts`. */
  goal: string;
  pass: number;
  hop: number;
  seq: number;
  /** What the model was sent was produced by code with this fingerprint. */
  fingerprint: string;
  context: { goal: string; table: PromptTable; history: GuideHistory; freshRefs?: readonly Ref[] };
  /** The run's Plugins, and what they added to this call. */
  plugins: readonly string[];
  contributions: readonly string[];
  /** What the model read. */
  sent: { system: string; tools: string; user: string };
  /** What it answered then, as the panel sent it back — `null` if no answer came. */
  answer: EffectOutcome | null;
}

/** A call in the log that did not become a state, and why. */
export interface Skipped {
  call: string;
  why: string;
}

interface HeaderRow {
  kind: 'header';
  run: string;
  plugins: readonly string[];
  fingerprint: string;
}

interface CallRow {
  kind: 'call';
  pass: number;
  id: string;
  seq: number;
  hop: number;
  params: CallModelParams;
  outcome: EffectOutcome | null;
  trace: Trace | null;
}

/**
 * Every call in a run's log as a state. A repair round belongs to the call it
 * repaired and is not a state of its own: the state is the request, and what
 * the model read is that request's user message.
 */
export function statesOf(rows: readonly Record<string, unknown>[]): { states: State[]; skipped: Skipped[] } {
  const header = rows.find((r) => r.kind === 'header') as HeaderRow | undefined;
  if (!header) throw new Error('日志没有第一行（kind: header）：它早于评估的 harness 有 main 函数（第 03 张），不能当语料');
  const states: State[] = [];
  const skipped: Skipped[] = [];
  for (const row of rows) {
    if (row.kind !== 'call') continue;
    const c = row as unknown as CallRow;
    const call = `P${c.pass}·${c.id}#${c.seq}`;
    if (!c.trace) {
      skipped.push({ call, why: '没有 trace：这次调用没等到结果，或调试开关没开' });
      continue;
    }
    const requests = c.trace.entries.filter((e) => e.kind === 'request');
    if (requests.length !== 1) {
      skipped.push({ call, why: `trace 里有 ${requests.length} 条请求，应当恰好 1 条` });
      continue;
    }
    const { goal, table, history, freshRefs, contributions } = c.params;
    states.push({
      id: `${header.run}/${c.id}/P${c.pass}/${c.seq}`,
      run: header.run,
      goal: c.id,
      pass: c.pass,
      hop: c.hop,
      seq: c.seq,
      fingerprint: header.fingerprint,
      context: { goal, table, history, ...(freshRefs ? { freshRefs } : {}) },
      plugins: header.plugins,
      contributions: contributions ?? [],
      sent: { system: c.trace.system, tools: c.trace.tools, user: requests[0]!.user },
      answer: c.outcome,
    });
  }
  return { states, skipped };
}

/**
 * The Context a call on this state is made with under `plugins` — the state's
 * own by default. The Plugins' paragraphs are collected the way the host
 * collects them, from the table's URL, never copied from the record.
 */
export function contextFor(state: State, plugins: readonly string[] = state.plugins): GuideContext {
  return { ...state.context, contributions: contributionsFor(pluginsNamed(plugins), state.context.table.url) };
}

/** The call a state records, rebuilt through today's code with the given Plugins. */
export function rebuild(
  state: State,
  plugins: readonly string[] = state.plugins,
): { system: string; tools: string; user: string; contributions: string[] } {
  const ctx = contextFor(state, plugins);
  const contributions = [...(ctx.contributions ?? [])];
  const [system, user] = guideAgent.buildMessages(ctx, () => NONCE);
  return {
    system: String(system!.content),
    tools: JSON.stringify(guideAgent.outputSchema(ctx)),
    user: String(user!.content),
    contributions,
  };
}

export type Part = 'contributions' | 'system' | 'tools' | 'user';

/** Which parts of the recorded call today's code does not give back — empty
 *  when the replay is the same call. */
export function differences(state: State): Part[] {
  const again = rebuild(state);
  const parts: Part[] = [];
  if (JSON.stringify(again.contributions) !== JSON.stringify(state.contributions)) parts.push('contributions');
  if (again.system !== state.sent.system) parts.push('system');
  if (again.tools !== state.sent.tools) parts.push('tools');
  if (pin(again.user) !== pin(state.sent.user)) parts.push('user');
  return parts;
}
