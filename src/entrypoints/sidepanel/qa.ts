import { ProviderError, type Usage } from '@/agent/provider';
import type { KnownEnvelope } from '@/agent/plan/contract';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { WireBinding, WireCheck, WireEvidence } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/**
 * Pure view-model logic behind `App.tsx`'s `runQuestion()` (07-panel-loop.md,
 * task 7).
 *
 * `App.tsx` depends on `chrome.*` and React rendering, and this repo runs
 * vitest under `environment: 'node'` with no jsdom and no component-test
 * precedent (see 07's README) — so `App.tsx` itself is proven only by the
 * e2e suite (08). Everything in *this* file is ordinary data-in/data-out
 * logic with no side effects, so it keeps the fast red→green loop the rest
 * of the codebase has. Whenever a judgment call in `runQuestion()` can be
 * phrased as "given this input, what should show?" rather than "go do this
 * chrome/network thing", it belongs here instead of inline in the component.
 */

/* ═══════════ 三种 intent 各自该渲染成什么 ═══════════ */

export interface QaOption {
  ref: Ref;
  label: string;
}

export interface QaAnswer {
  intent: 'explain' | 'clarify' | 'need_text';
  /** `explain`: the model's `answer`. `clarify`: the model's `question`.
   *  `need_text`: a fixed, non-fabricated string — see `NEED_TEXT_MESSAGE`. */
  message: string;
  /** Resolved elements to highlight via `PANEL_SHOW_QA_RESULT`. Empty means
   *  "send no highlight request" — `explain` with no refs, or `need_text`
   *  always. */
  items: readonly PromptItem[];
  /** `clarify` only: every candidate's label, for display next to the
   *  highlight. Never used to pick one — the caller passes all of `items`
   *  through to the host, which puts them all in `alsoRefs` (06, K-6). */
  options?: readonly QaOption[];
}

/**
 * `need_text`'s fixed copy. A constant, not a sentence built from the
 * model's own `query`/`blocks` fields — those are validated model output
 * (provenance already checked them), but weaving them into prose here would
 * read as "here is what the page says", which is exactly the fabrication
 * 07 forbids. The honest thing this intent can say is that the text could
 * not be read at all.
 */
export const NEED_TEXT_MESSAGE = '我还读不到这个页面的正文——正文管线要到后面的阶段才有。';

/**
 * Looks up `refs` in `table.items`, preserving order, dropping anything not
 * found. In practice nothing is ever dropped: `validateEnvelope`'s R-a
 * already proved every claimed ref exists in this same table before this
 * function ever runs. The filter exists so this function's own contract does
 * not silently depend on that upstream guarantee holding forever.
 */
function resolveItems(refs: readonly Ref[], table: PromptTable): PromptItem[] {
  const byRef = new Map(table.items.map((i) => [i.ref, i] as const));
  const out: PromptItem[] = [];
  for (const ref of refs) {
    const item = byRef.get(ref);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Turns a validated `Envelope` into what the panel should show and, if
 * anything, highlight. Never called with an envelope that failed
 * `validateEnvelope` — every ref inside is already known-safe (present in
 * this snapshot, not sensitive).
 */
export function describeAnswer(envelope: KnownEnvelope, table: PromptTable): QaAnswer {
  switch (envelope.intent) {
    case 'explain':
      return { intent: 'explain', message: envelope.answer, items: resolveItems(envelope.refs, table) };
    case 'clarify': {
      const options = envelope.options.map((o) => ({ ref: o.ref, label: o.label }));
      return {
        intent: 'clarify',
        message: envelope.question,
        items: resolveItems(
          options.map((o) => o.ref),
          table,
        ),
        options,
      };
    }
    case 'need_text':
      return { intent: 'need_text', message: NEED_TEXT_MESSAGE, items: [] };
  }
}

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
   */
  usage: Usage | null;
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

/* ═══════════ 三轴文案（05-route-and-steps.md §5.7）═══════════ */

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
 * arrive today", is the same discipline `describeAnswer` above already
 * follows for the wider `Envelope` union.
 */
export function describeEvidence(evidence: WireEvidence): string {
  switch (evidence) {
    case 'walked':
      return '曾经真实走过一遍';
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

/* ═══════════ 出错文案 ═══════════ */

/**
 * `complete()` never lets a raw error escape once it has decided the call
 * was genuinely aborted (see provider.ts's own catch block) — anything that
 * reaches here and is not a `ProviderError` is an even-more-unexpected
 * failure this function still has to say something honest about, rather
 * than leak `[object Object]` or a stack trace to the user.
 */
export function describeProviderError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  return `未知错误：${String((err as Error)?.message ?? err)}`;
}
