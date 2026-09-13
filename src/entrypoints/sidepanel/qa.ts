import { ProviderError, type Usage } from '@/agent/provider/provider';
import type { WireBinding, WireCheck, WireEvidence } from '@/shared/protocol';

/**
 * Pure view-model logic behind `App.tsx`'s `askPage()`.
 *
 * `App.tsx` depends on `chrome.*` and React rendering, and this repo runs
 * vitest under `environment: 'node'` with no jsdom and no component-test
 * precedent (see 07's README) — so `App.tsx` itself is proven only by the
 * e2e suite (08). Everything in *this* file is ordinary data-in/data-out
 * logic with no side effects, so it keeps the fast red→green loop the rest
 * of the codebase has. Whenever a judgment call in `askPage()` can be
 * phrased as "given this input, what should show?" rather than "go do this
 * chrome/network thing", it belongs here instead of inline in the component.
 */

/* ═══════════ 页面身份比对(Panel 侧,独立于 06 的 Host 侧核对) ═══════════ */

export interface QaContext {
  tabId: number | null;
  url: string;
  snapshotId: string | null;
}

/**
 * "问的时候"与"答案回来的时候"是不是同一个页面。这是 Panel 自己的判断——决
 * 定要不要连答案文字都不采纳——独立于 06 里 Host 在转发高亮前做的那次 url
 * 核对(`checkPageIdentity`，见 `shared/qa-highlight.ts`)。两层缺一个都不
 * 完整：Host 那层只挡得住"高亮指错地方"，挡不住"这条回答本来就已经跟当前
 * 页面对不上了，但文字还是被显示了出来"——而这正是本函数存在的理由。
 *
 * 比对三个字段而不是只比对 url：`tabId` 抓住"用户切换了标签页"，`url` 抓住
 * "同一个标签页导航走了"，`snapshotId` 抓住"没导航、但用户在等待期间又点了
 * 一次「抽取本页元素」，页面在同一个 URL 下已经不是当初那次快照"。
 */
export function sameQaContext(captured: QaContext, current: QaContext): boolean {
  return (
    captured.tabId === current.tabId &&
    captured.url === current.url &&
    captured.snapshotId === current.snapshotId
  );
}

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
   * `'merged'` is the third case, and it is not the same as `null`: the guide
   * path runs its repair round *inside* `runGuideToEnd`, so the endpoint's
   * figures come back already summed over both requests. The sum is recorded
   * on one record and its siblings say so, rather than claiming a number was
   * never reported — that claim is what the panel warns about, and it would be
   * false here.
   */
  usage: Usage | null | 'merged';
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
   *  (`Usage.estimated`) rather than reported by the endpoint. */
  estimated: boolean;
}

/**
 * Pure fold over every call made so far. Recomputed fresh on every render
 * from the full history rather than merged incrementally — the history for
 * one question is at most two entries (primary + repair), so recomputing
 * from scratch is cheaper than the bug surface of an incremental merge that
 * has to be kept in sync with this same logic.
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
 * `'walked'`/`'pass'` are mapped even though S2 never produces them (thread.
 * ts's own doc comments) — the type these functions take already carries
 * three members each, and a `switch` over a subset would either need a
 * default (silently swallowing a real S3/S4 value once it starts arriving) or
 * a cast. Handling the input type honestly, not "for a value that will never
 * arrive today", is the same discipline the question agent's answers
 * (`agent/agents/question/output/`) follow, one module per intent.
 */
export function describeEvidence(evidence: WireEvidence): string {
  switch (evidence) {
    case 'walked':
      return '曾经真实走过一遍';
    case 'handpicked':
      return '由你在元素表里亲手指定';
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
