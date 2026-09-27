import type { ModelUsage } from '@/agent/provider/types';
import { ProviderError } from '@/agent/provider/transport';
import type { WireBinding, WireCheck, WireEvidence } from '@/shared/types';

/**
 * Pure view-model logic behind `App.tsx`: the cost line, and how the three
 * axes are said.
 *
 * `App.tsx` depends on `chrome.*` and React rendering, and this repo runs
 * vitest under `environment: 'node'` with no jsdom and no component-test
 * precedent (see 07's README) — so `App.tsx` itself is proven only by the
 * e2e suite (08). Everything in *this* file is ordinary data-in/data-out
 * logic with no side effects, so it keeps the fast red→green loop the rest
 * of the codebase has. Whenever a judgment call in `App.tsx` can be
 * phrased as "given this input, what should show?" rather than "go do this
 * chrome/network thing", it belongs here instead of inline in the component.
 */

/* ═══════════ 成本面板：调用记账与合并 ═══════════ */

export interface CallRecord {
  kind: 'primary' | 'repair';
  /**
   * `null` exactly when the call threw before any `Delta` carrying `usage`
   * ever arrived — `complete()` promises usage on its last `Delta` (01), so
   * a call that got that far always has one. A `null` here still counts
   * toward `totalCalls` below: the request went out and, in most billing
   * models, was already paid for even though nothing useful came back.
   *
   * `'merged'` is the third case, and it is not the same as `null`: the agent
   * runs its repair round *inside* `runGuideToEnd`, so the endpoint's
   * figures come back already summed over both requests. The sum is recorded
   * on one record and its siblings say so, rather than claiming a number was
   * never reported — that claim is what the panel warns about, and it would be
   * false here.
   */
  usage: ModelUsage | null | 'merged';
}

export interface CostSummary {
  totalCalls: number;
  primaryCalls: number;
  repairCalls: number;
  /** Calls with no usage figure at all — contribute to the counts above but
   *  not to the token totals below, because there is nothing honest to add. */
  unknownCostCalls: number;
  prompt: number;
  completion: number;
  total: number;
  /** True when *any* contributing usage was character-count estimated
   *  (`ModelUsage.estimated`) rather than reported by the endpoint. */
  estimated: boolean;
}

/**
 * Pure fold over every call made so far. Recomputed fresh on every render
 * from the full history rather than merged incrementally — one record per
 * request this panel carried out, so recomputing from scratch is cheaper than
 * the bug surface of an incremental merge that has to be kept in sync with
 * this same logic.
 */
export function summarizeCost(calls: readonly CallRecord[]): CostSummary {
  let primaryCalls = 0;
  let repairCalls = 0;
  let unknownCostCalls = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let estimated = false;

  for (const c of calls) {
    if (c.kind === 'primary') primaryCalls++;
    else repairCalls++;

    // Counted, but its tokens live on a sibling record — nothing to add and
    // nothing to warn about.
    if (c.usage === 'merged') continue;
    if (!c.usage) {
      unknownCostCalls++;
      continue;
    }
    prompt += c.usage.prompt;
    completion += c.usage.completion;
    total += c.usage.total;
    if (c.usage.estimated) estimated = true;
  }

  return {
    totalCalls: calls.length,
    primaryCalls,
    repairCalls,
    unknownCostCalls,
    prompt,
    completion,
    total,
    estimated,
  };
}

/* ═══════════ 三轴文案（设计文档 §5.7）═══════════ */

/**
 * §5.7's three orthogonal axes, mapped to display text. Kept as three
 * independent functions rather than one combined "confidence" summary —
 * merging them is exactly what the design doc's Gotchas warn against ("合并
 * 任意两轴都会造出一个既不能解释也不能复核的等级"): a caller that wants all
 * three on screen calls all three, side by side, never folded into one.
 *
 * Every member of each axis is mapped, and each `switch` is exhaustive with no
 * default: a new value arriving later fails the type check here instead of
 * being silently swallowed. The same discipline the guide agent's intent
 * modules (`agent/agents/guide/output/`) follow.
 */
export function describeEvidence(evidence: WireEvidence): string {
  switch (evidence) {
    case 'documented':
      return '依据站内文档';
    case 'model':
      return '模型推断，未经验证';
  }
}

export function describeCheck(check: WireCheck): string {
  switch (check) {
    case 'pass':
      return '已验证到达期望';
    case 'unknown':
      return '尚未验证是否到达期望';
    case 'skipped':
      return '未做验证';
  }
}

export function describeBinding(binding: WireBinding): string {
  switch (binding) {
    case 'bound':
      return '此刻可以指出来';
    case 'ambiguous':
      return '此刻有多个候选，未挑一个';
    case 'unbound':
      return '此刻指不出来';
  }
}
