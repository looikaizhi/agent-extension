import type { HostSignal, TokenUsage } from '@/agent/api';
import type { ClarifyOption } from '@/agent/plan/contract';
import type { GuideHistory } from '@/agent/plan/prompt';
import { guideAgent } from '@/agent/guide/agent';
import { judgeArrival, toGuideStep } from '@/agent/plan/validate';
import { sameHost } from '@/core/security/link-safety';
import { packsFor } from '@/core/packs/match';
import { groundFromPageLink } from '@/agent/ground/docs';
import type { PromptTable } from '@/core/extractor/types';
import type { GuideStep, HighlightMode } from '@/shared/protocol';
import type { Ref } from '@/shared/types';
import type { AbandonedReason, GuideHistoryEntry, InflightEffect, ThreadState } from './thread';

/**
 * The pure reducer at the center of S2 (03-machine-reducer.md, ADR 0008,
 * ADR 0009). `step` is this file's only export other than types — no helper
 * here is meant to be called from outside it.
 *
 * N-2 (design doc §2.7, 03-machine-reducer.md Gotchas): no `await`, no
 * `fetch(`, no `chrome.`, anywhere below this line. That is what lets a
 * persisted `ThreadState` be replayed deterministically in a plain node test,
 * and what lets `entrypoints/background.ts` trust that calling `step` twice
 * with the same `{state, input}` can never produce two different answers —
 * there is nothing in this file that could make it look at the clock, the
 * network, or the platform. `tests/unit/architecture.spec.ts` asserts this
 * with a grep; the assertion is trivially satisfiable *because* nothing here
 * ever needs those things — a decision is not an execution.
 *
 * Single-writer (ADR 0009): this file has no way to enforce "only
 * `background.ts` calls `step`" from inside itself — a pure function cannot
 * refuse a caller. The enforcement lives in `tests/unit/architecture.spec.ts`
 * (grep: nothing outside `agent/api.ts` may import `step`) precisely because
 * the danger this guards against (a second process — the side panel —
 * running the same reducer to "predict" a cursor move) is not a defect this
 * file's code could ever exhibit on its own; it is a defect in *who calls
 * it*, which only a cross-file guard can catch.
 */

/** CONTEXT.md's renderer-stamped axis: "此刻能不能把它指出来". Distinct from
 *  `core/packs/bind.ts`'s `BindResult` — that is a table-only match attempt
 *  (`'unique' | 'ambiguous' | 'not_found'`) this file never runs itself
 *  (bindStep needs no `chrome.*`, but its inputs — a live snapshot — are the
 *  content script's, not this reducer's to fabricate). A `Binding` value only
 *  ever arrives *already computed*, via a `bind_result` input, from the
 *  renderer's own attempt against whatever page is on screen right now. */
export type Binding = 'bound' | 'ambiguous' | 'unbound';

/** design doc §2.6's `EffectRequest.at` / `EffectResult.at`: the world state
 *  a dispatched effect was issued against. */
export interface WorldAt {
  threadRev: number;
  snapshotId: string;
  pageHash: string;
  url: string;
}

/** Mirrors `host/effect.ts`'s `EffectFailureKind`, declared again rather than
 *  imported for the same reason that file keeps its own copies: it is a leaf
 *  by design, and this reducer is the other end of the same wire, not a
 *  dependent of it. */
export type EffectFailureKind = 'transport' | 'parse' | 'violation';

export type EffectOutcome =
  | { ok: true; value: string; usage?: TokenUsage; providerCalls: number; tool?: string }
  | { ok: false; error: string; retryable: boolean; failureKind: EffectFailureKind; providerCalls: number };

/**
 * The five event kinds `step` recognises (03-machine-reducer.md Seam).
 *
 * Every id is supplied by the caller, never minted here: `crypto.randomUUID()`
 * is exactly the kind of hidden input N-2's determinism requirement forbids
 * reading directly.
 *
 * `nextEffectId` is required on `effect_result` even though only two of its
 * branches ever spend one (an E-3 replan, a `need_docs` envelope asking for a
 * fetch). It used to be optional, guarded by a throw on each of those two
 * branches — which made correctness depend on the caller predicting which
 * branch this reducer would take, and that prediction needs the payload
 * already parsed. Neither real caller could make it, neither did, and both
 * throws fired in the first live run. An unspent id costs nothing (it is
 * stored only when an effect is actually dispatched), so requiring it turns a
 * runtime landmine into a compile-time obligation and deletes both throws.
 */
export type MachineInput =
  | { kind: 'start'; goal: string; table: PromptTable; effectId: string }
  | {
      kind: 'effect_result';
      effectId: string;
      at: WorldAt;
      outcome: EffectOutcome;
      nextEffectId: string;
    }
  | { kind: 'host_signal'; signal: HostSignal }
  | { kind: 'bind_result'; binding: Binding }
  | { kind: 'cross_site_decision'; confirmed: boolean }
  /** The settle window closed and the page never moved — `background.ts`'s
   *  re-plan loop is the only thing that can observe that, because deciding
   *  it requires a clock. */
  | { kind: 'step_settle_timeout' }
  | { kind: 'page_changed'; table: PromptTable; effectId: string };

/**
 * The two effect families design doc §2.1/§2.6 name — platform effects Host
 * executes itself (`present`), and external-world effects Host delegates to
 * Panel (`callModel`/`fetchDoc`, 04-effect-protocol.md). This file produces
 * only *values* describing what should happen next; it never distinguishes
 * the two families beyond their `kind` tag, and never executes either.
 *
 * `extract` (the Seam's other platform effect) is not a member yet: every
 * one of this task's fifteen slices hands `step` an already-extracted table
 * directly (`start`/`page_changed`'s `table` field) rather than asking the
 * reducer to request one — nothing in 03 ever needs to *decide* an
 * extraction is required. It joins this union in whichever later stage
 * first needs the reducer to ask for one.
 */
export type MachineEffect =
  | { kind: 'present'; step: GuideStep; index: number; total: number; mode: HighlightMode }
  | {
      kind: 'callModel';
      effectId: string;
      goal: string;
      table: PromptTable;
      history: GuideHistory;
      /** From this site's pack, when it has one (`siteNotesFor`). */
      siteNotes?: string;
    }
  /** `url` is already approved: the host decided, the panel only fetches
   *  (§8.3). It arrives here from the page's own link, never from the model. */
  | { kind: 'fetchDoc'; effectId: string; viaRef: Ref; query: string; url: string }
  /** CL-1: the model asked the user a question instead of planning a step
   *  (§5.8). Carries the question and *every* candidate the model listed, in
   *  the model's own order — narrowing them to one here would be the K-6
   *  violation the whole clarify channel exists to avoid. */
  | { kind: 'clarify'; question: string; options: readonly ClarifyOption[] }
  /** This step leaves the site. Ask before the user commits to it — the
   *  promise is that they see the destination *before* going, not after
   *  (§8.4). `from`/`to` are full hostnames: this stage has no brand
   *  extraction, so the card says the literal address and claims nothing
   *  about who owns it. */
  | { kind: 'requestCrossSiteConfirm'; from: string; to: string }
  /** The journey looks finished. A *proposal*, not a verdict: `status` stays
   *  `active` and the user confirms. §1.3's probe found the model's own
   *  self-assessment unreliable enough that letting it declare success would
   *  put L-4 — this product's only hard zero — on the ending itself.
   *
   *  `source` separates two opposite events that used to arrive here
   *  indistinguishable and come out as one sentence, 「看起来已经到了：…」.
   *  `'model'` means the model read the page and believes the user has
   *  arrived; `'backstop'` means it proposed a control already used and the
   *  guide stopped rather than circle. One is an arrival, the other is a guide
   *  that stopped going anywhere, and telling a user the second is the first
   *  is a lie the renderer had no way to avoid. */
  | { kind: 'done'; why: string; source: 'model' | 'backstop' }
  /** The one non-platform, non-external-world effect this file produces: a
   *  pure "tell the user" value for a terminal or recoverable-error state
   *  that has no `GuideStep` to attach to (quota exhaustion, an unresolved
   *  target, a contract violation). `reason` is set only for the terminal
   *  quota case — 03-machine-reducer.md Gotchas: "effects 里包含一个把这个
   *  原因告知用户的展示 effect". */
  | { kind: 'notify'; message: string; reason?: AbandonedReason };

const UNRESOLVED_MESSAGE = '找不到这一步的目标，页面可能已经变化。';

/** Every control the model was shown last time, in the order it was shown
 *  them. `ref` is deliberately absent: refs are minted per snapshot
 *  (CONTEXT.md, "跨快照无意义"), so including them would make every
 *  re-extraction look like a change. */
const controlsOf = (t: PromptTable) => t.items.map((i) => `${i.path.join('>')}|${i.role}|${i.name}`).join('\n');

/**
 * D4's "页面确实变了", as one predicate both the reducer and `agent/api.ts`'s
 * pre-`step` guard read — the two used to compare `pageHash` each on their own
 * line, and a rule written twice is a rule that drifts.
 *
 * Two signals, either one sufficient:
 *
 * - **`pageHash`** — route plus landmark/heading structure
 *   (`core/extractor/fingerprint.ts`). Catches real navigations, which is what
 *   carries a multi-page journey forward.
 * - **The control list** — catches what `pageHash` is deliberately blind to. A
 *   menu, dropdown or dialog opening adds no landmark and no heading, so the
 *   fingerprint does not move, yet the page now offers a completely different
 *   set of things to do and the step on screen has already been done. That
 *   blindness is correct for the *watcher* (a hash reacting to every
 *   async-loaded button would invalidate the guide constantly) and wrong for
 *   *this* judgement, which is only ever reached after something already
 *   claimed the page moved.
 *
 * Both readings of "changed" are structural — no timers, no heuristics about
 * how much changed. A page that swapped one control for another moved; a page
 * that repainted the same controls did not.
 */
export function pageMoved(prev: PromptTable, next: PromptTable): boolean {
  return next.pageHash !== prev.pageHash || controlsOf(next) !== controlsOf(prev);
}

/**
 * Why a doc fetch was declined, said plainly — and naming the host it would
 * really have gone to, which is the one fact worth acting on. Every line
 * describes what we observed about the address; none claims anything about
 * who is behind it (§8.4's limits — we are not a security product).
 */
function groundRefusal(reason: 'userinfo' | 'scheme' | 'private_network' | 'homograph' | 'unresolvable', href?: string): string {
  let host = '';
  try {
    if (href) host = new URL(href).hostname;
  } catch {
    /* an address we cannot read is described without one */
  }
  const at = host ? `（${host}）` : '';
  switch (reason) {
    case 'userinfo':
      return `这条链接的地址里藏了登录信息，真正会去的站点${at}和它看起来的不是同一个。`;
    case 'scheme':
      return '这条链接不是普通的网页地址。';
    case 'private_network':
      return `这条链接指向的是你自己网络里的地址${at}，不会是一份文档。`;
    case 'homograph':
      return `这条链接的主机名${at}不是纯 ASCII，我读不准它到底是哪个站点。`;
    case 'unresolvable':
      return '页面上已经找不到这条链接了。';
  }
}

function quotaMessage(effectKind: 'callModel' | 'fetchDoc'): string {
  return effectKind === 'callModel'
    ? '这条引导已用满模型调用上限（12 次），已停止。'
    : '这条引导已用满文档抓取上限（5 次），已停止。';
}

/** Settles the outcome of the step currently on screen — the last history
 *  entry, and only while it is still `unknown`. A step whose fate is already
 *  recorded is never rewritten: `confirmed` and `invalidated` come from two
 *  different inputs that can both arrive for the same step, and the first one
 *  to arrive is the one that actually happened. */
function stamp(
  history: readonly GuideHistoryEntry[],
  outcome: GuideHistoryEntry['outcome'],
  landedAt?: string,
): readonly GuideHistoryEntry[] {
  const last = history[history.length - 1];
  if (!last || last.outcome !== 'unknown') return history;
  return [...history.slice(0, -1), { ...last, outcome, ...(landedAt !== undefined ? { landedAt } : {}) }];
}

const notify = (message: string, reason?: AbandonedReason): MachineEffect => ({ kind: 'notify', message, reason });

function present(state: ThreadState, index: number): MachineEffect {
  const guideStep = state.steps[index];
  if (!guideStep) throw new Error(`machine.ts: no step at index ${index} to present`);
  return {
    kind: 'present',
    step: guideStep,
    index,
    total: state.steps.length,
    mode: state.steps.length > 1 ? 'guide' : 'locate',
  };
}

/** Same place, not same address: origin + pathname, so a query string that
 *  gained a tracking parameter is not a different page. */
function samePlace(a: string, b: string): boolean {
  const key = (raw: string) => {
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}

function hostOf(raw: string): string | null {
  try {
    const h = new URL(raw).hostname;
    return h === '' ? null : h.toLowerCase();
  } catch {
    return null;
  }
}

const crossSiteAsk = (fromUrl: string, to: string): MachineEffect => ({
  kind: 'requestCrossSiteConfirm',
  from: hostOf(fromUrl) ?? fromUrl,
  to,
});

/**
 * `cross_site_decision` — the user's answer to P-2's card.
 *
 * Declining is not an error and not the end of the run: the guide simply stays
 * where it is with the step unshown, and spends nothing. Accepting presents
 * the step that was already loaded behind the card, and records where it leads
 * so the next breakpoint knows to run P-3 against the landing page.
 */
/**
 * `step_settle_timeout` — the user activated the step and the page did not
 * move (`replan.ts` looked several times before saying so).
 *
 * "Did not move" is not "did not work". Clicking a search button opens a
 * dialog; opening a menu expands it; both leave `pageMoved` false because the
 * route is unchanged and — for a dialog — extraction scopes into it, so the
 * control list is compared against a table describing somewhere else. The
 * user did exactly what was asked. What is missing is the rest of the plan.
 *
 * So the first question is whether this plan has a rest. The model writes
 * `e6 click` then `e6 input value:"n8n"` — click the search open, then type
 * into it — reusing the same ref because the dialog's textbox is not in the
 * table yet (`CHOICE_GUIDE` now asks for exactly this shape). Before this
 * branch existed `cursor` never advanced anywhere in the codebase, so that
 * second step was planned and then discarded, and four of seven live journeys
 * ended right here reading 「这一步看起来没有反应」 while the thing to do next
 * sat unused in `steps[1]`.
 *
 * Advancing costs no quota — the step is already planned and already
 * validated against the table it was drawn from. Only when the plan really is
 * exhausted does the old message stand: then there is nothing left to offer,
 * and a control that did not respond is a step to retry or skip, not a reason
 * to stop guiding.
 *
 * `stamp` keeps its first-come-wins rule, so a step whose fate is already
 * recorded is never rewritten — the page moving and the window closing can
 * both arrive for the same step, and the one that arrived first is the one
 * that actually happened.
 */
function handleStepSettleTimeout(state: ThreadState): StepOut {
  const last = state.history[state.history.length - 1];
  if (!last || last.outcome !== 'unknown') return { state, effects: [] };

  const next = state.cursor + 1;
  if (next < state.steps.length) {
    // `confirmed` is not ours to write — `handlePageChanged`'s doc comment
    // reserves it for the one place that has proven the page moved, and
    // nothing here has proven that. What is known is narrower and is what
    // gets recorded: the user acted on this step, and the guide moved on.
    const advanced: ThreadState = {
      ...state,
      cursor: next,
      outcomes: state.outcomes.map((o, i) => (i === state.cursor ? o ?? 'skipped' : o)),
      history: [...state.history, { title: state.steps[next]!.title, url: state.table.url, outcome: 'unknown' }],
    };
    return { state: advanced, effects: [present(advanced, next)] };
  }

  return {
    state: { ...state, history: stamp(state.history, 'failed') },
    // The screen still shows the same page and the same highlight, so without
    // this the user has no way to tell a slow page from a dead control.
    effects: [notify(`「${last.title}」这一步看起来没有反应，可以再试一次，或者跳过它。`)],
  };
}

function handleCrossSiteDecision(
  state: ThreadState,
  input: Extract<MachineInput, { kind: 'cross_site_decision' }>,
): StepOut {
  const to = state.pendingCrossSite;
  if (!to) return { state, effects: [] }; // nothing was pending — a stale answer
  const cleared = { ...state, pendingCrossSite: undefined };
  if (!input.confirmed) return { state: cleared, effects: [] };
  return { state: { ...cleared, crossedTo: to }, effects: [present(cleared, 0)] };
}

const worldAtOf = (table: PromptTable, threadRev: number): WorldAt => ({
  threadRev,
  snapshotId: table.snapshotId,
  pageHash: table.pageHash,
  url: table.url,
});

type StepOut = { state: ThreadState; effects: MachineEffect[] };

/**
 * Single-writer chain's "inflight is a tombstone, not a queue" (03-machine-
 * reducer.md 单写者链) plus §5.10's quota, in one gate — every path that
 * wants to dispatch a `callModel` funnels through here so the two rules can
 * never be checked in only one of them.
 *
 * A blocked-by-inflight attempt is silent (slice 2: unchanged state, no
 * effects) — this is not a user-facing event, it is the reducer declining a
 * redundant request its caller should not have made. A blocked-by-quota
 * attempt is a terminal state the user must be told about (slice 11).
 */
/**
 * What a human wrote down about this site, from its pack.
 *
 * This is where a site's own vocabulary belongs — how its search box wants a
 * query, what its odd control names mean — and deliberately not in the system
 * message: a general prompt that carries one site's search syntax makes every
 * other site's users pay for it, and the list can never be finished. A page
 * with no pack gets nothing, which is the normal case.
 *
 * Several packs can match one URL; their notes are joined, because a pack is
 * scoped by domain and two that both matched are both about this page.
 */
function siteNotesFor(url: string): string | undefined {
  const notes = packsFor(url)
    .map((p) => p.siteNotes)
    .filter((n): n is string => Boolean(n));
  return notes.length ? notes.join('\n') : undefined;
}

function tryEmitCallModel(state: ThreadState, effectId: string, nextRev: number): StepOut {
  if (state.inflight) return { state, effects: [] };
  if (state.callCount >= 12) {
    return {
      state: { ...state, status: 'abandoned', abandonedReason: 'quota_exceeded', inflight: null },
      effects: [notify(quotaMessage('callModel'), 'quota_exceeded')],
    };
  }
  const inflight: InflightEffect = { effectId, kind: 'callModel', at: worldAtOf(state.table, nextRev) };
  return {
    state: { ...state, callCount: state.callCount + 1, inflight },
    effects: [
      {
        kind: 'callModel',
        effectId,
        goal: state.goal,
        table: state.table,
        history: { done: state.history, route: state.route },
        // Looked up here rather than in the panel because it is a decision
        // about *what this thread is told*, and those live on the host. It is
        // also pure — `packsFor` reads a static table and nothing else — so
        // N-2 holds.
        ...(siteNotesFor(state.table.url) ? { siteNotes: siteNotesFor(state.table.url) } : {}),
      },
    ],
  };
}

/** `fetchDoc`'s counterpart to `tryEmitCallModel` — same two gates
 *  (tombstone, then its own independent quota), against `docFetchCount`. */
function tryEmitFetchDoc(state: ThreadState, viaRef: Ref, query: string, effectId: string, nextRev: number): StepOut {
  if (state.inflight) return { state, effects: [] };
  if (state.docFetchCount >= 5) {
    return {
      state: { ...state, status: 'abandoned', abandonedReason: 'quota_exceeded', inflight: null },
      effects: [notify(quotaMessage('fetchDoc'), 'quota_exceeded')],
    };
  }
  // 06: only a link the page itself offers, and only after the four
  // structural red flags. The address comes from the table — the page
  // vouching for its own link — never from the model, which outputs refs and
  // never URLs (S-07). Deciding here and fetching in the panel is §8.3's
  // split: what crosses that boundary is always already approved.
  const linked = state.table.items.find((i) => i.ref === viaRef)?.href;
  const decision = groundFromPageLink(viaRef, linked, state.table.url);
  if (!decision.ok) {
    return { state, effects: [notify(`没有抓取这份文档：${groundRefusal(decision.reason, linked)}`)] };
  }
  const inflight: InflightEffect = { effectId, kind: 'fetchDoc', at: worldAtOf(state.table, nextRev) };
  return {
    state: { ...state, docFetchCount: state.docFetchCount + 1, inflight },
    effects: [{ kind: 'fetchDoc', effectId, viaRef, query, url: decision.url }],
  };
}

function handleStart(input: Extract<MachineInput, { kind: 'start' }>, nextRev: number): StepOut {
  const fresh: ThreadState = {
    rev: 0, // the `step` wrapper overwrites this with `nextRev`
    goal: input.goal,
    table: input.table,
    route: [],
    steps: [],
    cursor: 0,
    outcomes: [],
    history: [],
    status: 'active',
    // §5.7: the only `Evidence`/`Check` values S2 ever produces (thread.ts's
    // own doc comments on these two fields explain why the other members of
    // each union exist but are never reached from here).
    evidence: 'model',
    check: 'unknown',
    callCount: 0,
    docFetchCount: 0,
    // Seeded with the screen this run starts on, so the opening call is the
    // only one spent on it.
    inflight: null,
  };
  return tryEmitCallModel(fresh, input.effectId, nextRev);
}

/**
 * `effect_result` — the one branch that has to interpret a raw model or
 * fetch response. E-2 (idempotent discard) and E-3 (world-mismatch discard +
 * auto-replan) run *before* anything in the payload is trusted; only a
 * result that survives both is handed to `guideAgent.parseOutput`/`.validate`.
 */
/**
 * One sentence per failure kind, shared by both routes to the same verdict:
 * the panel's `ok:false` (all the host gets when the envelope was refused
 * over there) and this reducer's own re-derivation below. Two wordings for
 * one condition is a divergence no test would catch, so there is one table.
 */
const FAILURE_TEXT: Record<EffectFailureKind, (detail: string) => string> = {
  transport: (d) => `调用失败：${d}`,
  parse: (d) => `模型输出无法解析：${d}`,
  violation: (d) => `模型输出不合法：${d}`,
};

function handleEffectResult(
  state: ThreadState,
  input: Extract<MachineInput, { kind: 'effect_result' }>,
  nextRev: number,
): StepOut {
  // E-2: not the effect we are waiting for (stale duplicate, or nothing was
  // ever inflight) — ignored outright, not even an error.
  if (!state.inflight || state.inflight.effectId !== input.effectId) {
    return { state, effects: [] };
  }

  // §5.9 says a repair call counts against the same 12-call cap as the call
  // it repairs. It never did: `tryEmitCallModel` charges exactly 1 when it
  // dispatches, while the repair round happens *inside* the effect, where the
  // host cannot see it — so 12 dispatched effects could spend up to 24 real
  // requests and `callCount` would still read 12. The panel now reports what
  // it actually spent, and this adds whatever exceeded the one already
  // charged. Applied before E-3, not after: a result discarded for arriving
  // in the wrong world was still paid for.
  const unbilled = Math.max(0, input.outcome.providerCalls - 1);
  const cleared: ThreadState = { ...state, inflight: null, callCount: state.callCount + unbilled };

  const worldMatches =
    input.at.threadRev === state.inflight.at.threadRev &&
    input.at.snapshotId === state.table.snapshotId &&
    input.at.pageHash === state.table.pageHash &&
    input.at.url === state.table.url;

  if (!worldMatches) {
    // E-3: discard the result outright and replan unconditionally — the
    // Gotchas are explicit that this does not wait for a new user input.
    // `state.table` already reflects whatever changed (only `page_changed`
    // moves it, and that input carries the fresh table with it), so the
    // replan needs nothing from this stale result beyond triggering it.
    return tryEmitCallModel(cleared, input.nextEffectId, nextRev);
  }

  if (!input.outcome.ok) {
    // Three different things, three different sentences. The panel runs the
    // same `parseOutput`/`validate` this reducer does, and on a refusal it
    // returns `ok:false` — so the model's text never reaches here and the
    // verdict cannot be re-derived (design doc §8.3 gives the host the last
    // word, but only over text it actually receives). Saying 「调用失败」 to
    // a user whose plan was refused for naming a password field was wrong
    // twice over: the call succeeded, and the reason was worth telling.
    return { state: cleared, effects: [notify(FAILURE_TEXT[input.outcome.failureKind](input.outcome.error))] };
  }

  // Re-derived here, not trusted from the panel (§8.3, "判定权在 Host"). The
  // intent is the function the model called, not a field in the text, so the
  // host has to be told which one — `value` is the arguments and cannot say.
  // A `callModel` result without it is a `fetchDoc` result or a bug, and
  // either way there is no envelope to recover.
  const parsed = input.outcome.tool
    ? guideAgent.parseOutput(input.outcome.tool, input.outcome.value)
    : ({ kind: 'error', message: '结果里没有工具名，无法判断这是哪一种信封' } as const);
  if (parsed.kind === 'error') {
    return { state: cleared, effects: [notify(FAILURE_TEXT.parse(parsed.message))] };
  }
  const validated = guideAgent.validate(parsed.envelope, state.table);
  if (validated.kind === 'violation') {
    return { state: cleared, effects: [notify(FAILURE_TEXT.violation(validated.reason))] };
  }

  const envelope = validated.envelope;

  if (envelope.intent === 'done') {
    return { state: cleared, effects: [{ kind: 'done', why: envelope.why, source: 'model' }] };
  }

  if (envelope.intent === 'guide') {
    // R-b already guarantees `steps.length > 0` (`guideAgent.validate`), so
    // `present` always has a step 0 to point at.
    const steps = envelope.steps.map((s) => toGuideStep(s, state.table));

    // The backstop, not the main defence: a model told where the user has
    // already been should stop on its own (the history in its user message), and
    // this catches the times it does not. Same two-independent-layers shape as
    // `pageMoved`'s content-script check and its host-side re-check.
    //
    // Scoped to a step that was *just* confirmed. Repeating a control is
    // legitimate in general — the same field can be filled twice — but a step
    // whose completion has already been proven has no reason to be redone, and
    // proposing it again is the loop that made five live GitHub rounds all
    // stall on their first step.
    //
    // Matched on title *and* where that control last led.
    //
    // Title alone cannot tell the two apart, and they are opposites. The
    // search box that carried the user to `/repo` is still in the nav bar of
    // `/repo`; proposing it there to search for something else is ordinary
    // use. Proposing it while the user is still on the page it already took
    // them from is the loop — five live GitHub rounds all stalled on exactly
    // that, re-proposing the control they had just finished with.
    //
    // `landedAt` is what separates them: it records where the step actually
    // got to, not merely what was pressed. When it is absent — an older entry,
    // or a step whose arrival was never observed — the check falls back to
    // title alone and stops. The costs are not symmetric: a misfire tells the
    // user "looks like you're there" and they ask again, while a missed cycle
    // burns the whole 12-call quota.
    //
    // Scanned across the whole history rather than the last entry, because the
    // loop that shows up is a *cycle*: 搜索按钮 → 搜索输入框 → 搜索按钮 reads
    // as two different titles in a row and slips past any check on the
    // previous step alone.
    const seen = cleared.history.find(
      (h) =>
        h.outcome === 'confirmed' &&
        h.title === steps[0]!.title &&
        // Did that step actually take the user anywhere? `landedAt` is where
        // it got to; `h.url` is where it was proposed. Equal means it moved
        // nobody, so proposing it again is the loop. Different means it did
        // carry the user forward, and the same control appearing later — the
        // search box still sitting in the nav bar of the page it led to — is
        // ordinary reuse, not a cycle.
        (h.landedAt === undefined || samePlace(h.landedAt, h.url)),
    );
    if (seen) {
      return {
        state: cleared,
        effects: [
          {
            kind: 'done',
            why: `模型又一次指向已经用过的「${seen.title}」，引导没有再往前走。`,
            source: 'backstop',
          },
        ],
      };
    }
    const next: ThreadState = {
      ...cleared,
      route: envelope.route,
      steps,
      cursor: 0,
      outcomes: steps.map(() => undefined),
      // Recorded here rather than at the render site: `history` has to survive
      // the wholesale replacement of `steps`/`cursor`/`outcomes` happening on
      // the very same line, and this is the only place that replacement occurs.
      history: [...cleared.history, { title: steps[0]!.title, url: state.table.url, outcome: 'unknown' }],
      // Kept on the thread, not on the `GuideStep`: the renderer has no use
      // for a prediction, the host does — it is what the next breakpoint
      // checks the arrived page against.
      ...(envelope.steps[0]!.expect_after ? { expect: envelope.steps[0]!.expect_after } : { expect: undefined }),
    };
    // P-2: if this step leaves the site, the destination gets said out loud
    // before the user commits to it. The address comes from the *table* — the
    // page vouching for its own link — never from the model, which outputs
    // refs and never URLs (S-07).
    const target = state.table.items.find((i) => i.ref === steps[0]!.ref)?.href;
    if (target && !sameHost(state.table.url, target)) {
      const to = hostOf(target);
      // The step stays loaded behind the card: answering `true` presents it
      // without another model call, answering `false` costs nothing at all.
      if (to) return { state: { ...next, pendingCrossSite: to }, effects: [crossSiteAsk(state.table.url, to)] };
    }
    return { state: next, effects: [present(next, 0)] };
  }

  if (envelope.intent === 'need_docs') {
    return tryEmitFetchDoc(cleared, envelope.via_ref, envelope.query, input.nextEffectId, nextRev);
  }

  if (envelope.intent === 'clarify') {
    // CL-1 (§5.8): not a contract mismatch — `clarify` is one of the four
    // functions a guide call may answer with, and the model reaches for it
    // often enough to matter (10% of calls in the last live run). The thread
    // parks on the question with its steps intact rather than ending: the
    // user answers by asking again more specifically, and `page_changed`
    // still re-plans underneath them if the page moves meanwhile.
    return {
      state: { ...cleared, clarify: 'CL-1' },
      effects: [{ kind: 'clarify', question: envelope.question, options: envelope.options }],
    };
  }

  // explain/need_text: ADR 0004 routes those through the stateless QA path,
  // never through a Thread. A guide-flow callModel answering with one of
  // these shapes is a contract mismatch this reducer cannot silently paper
  // over — report it and leave the run recoverable (not abandoned).
  return { state: cleared, effects: [notify(`模型返回了非引导类信封（intent: ${envelope.intent}）`)] };
}

/**
 * `host_signal` — S1's existing five-value `HostSignal`. `confirmed`'s
 * cursor-advancing semantics need `page_changed` in the same judgement (D4:
 * "点击 + 页面确实变了", 03-machine-reducer.md slice 8) — that composite
 * judgement is 07-cross-site-and-outcome.md's job. 03's only obligation is
 * that this input kind is safe to accept without disturbing anything else,
 * which a later `page_changed` in the same sequence continues to prove
 * (slice 8's actual assertion).
 */
function handleHostSignal(state: ThreadState, _input: Extract<MachineInput, { kind: 'host_signal' }>): StepOut {
  return { state, effects: [] };
}

/**
 * `bind_result` — CL-2's other half (`judgeFirstStepBind` in
 * `agent/plan/validate.ts` is the pure judgement over a *table-only*
 * `BindResult`; this is the live-DOM report the renderer produces when it
 * actually tries to paint `steps[cursor]`, which is the only place an
 * `ambiguous` *Binding* can come from — see this file's Seam doc comment on
 * `Binding`). Deliberately not routed through `judgeFirstStepBind`: that
 * function's input type carries `ref`/`item`/`refs`/`items` fields a
 * `Binding` value has no data for, so bridging the two would mean
 * fabricating fields nobody has rather than reusing real logic — the
 * `'ambiguous'` check both would run is one line long on either side of that
 * bridge.
 */
function handleBindResult(state: ThreadState, input: Extract<MachineInput, { kind: 'bind_result' }>): StepOut {
  if (input.binding === 'bound') return { state, effects: [] };

  if (state.cursor === 0 && input.binding === 'ambiguous') {
    // CL-2: escalate, do not advance, do not spend another callModel.
    return { state: { ...state, clarify: 'CL-2' }, effects: [] };
  }

  // `unbound`, and `ambiguous` anywhere but the fresh first step: S1's
  // existing "未能定位" path (not CL-2 — Gotchas are explicit that CL-2 is
  // scoped to the first step of a freshly-produced `steps` array only).
  const outcomes = state.outcomes.slice();
  outcomes[state.cursor] = 'invalidated';
  return {
    state: { ...state, outcomes, history: stamp(state.history, 'invalidated') },
    effects: [notify(UNRESOLVED_MESSAGE)],
  };
}

/**
 * `page_changed` — §5.3's re-planning trigger. The caller (`background.ts`)
 * always hands over a freshly extracted table; this function's entire job is
 * deciding whether that table's `pageHash` actually differs from what the
 * current `steps` were planned against (slice 10 guards the "no, nothing
 * really changed" case at this layer rather than trusting the caller never
 * to over-report).
 */
function handlePageChanged(state: ThreadState, input: Extract<MachineInput, { kind: 'page_changed' }>, nextRev: number): StepOut {
  if (!pageMoved(state.table, input.table)) return { state, effects: [] };

  // P-3: the user just agreed to leave their site, and the page they landed on
  // wants credentials. Stop, and say only what we actually observed.
  //
  // Scoped to the hop right after a *confirmed* cross-site jump, and spent
  // after one check: "this page asks for your password" is unremarkable on a
  // site the user chose, and worth stopping for on one they were just taken
  // to. Checking everywhere would train them to dismiss it.
  if (state.crossedTo && input.table.items.some((i) => i.sensitive)) {
    return {
      state: {
        ...state,
        table: input.table,
        crossedTo: undefined,
        history: stamp(state.history, 'invalidated'),
        status: 'abandoned',
        abandonedReason: 'credentials_on_unfamiliar_site',
      },
      // Deliberately not "this site is unsafe" — we are not a security product
      // and cannot substantiate that (§8.4's closing note on our limits). We
      // describe what we saw and what we did about it.
      effects: [
        notify(
          `这一步把你带到了 ${state.crossedTo}，而那一页要求输入账号信息。为安全起见，引导已经停下。`,
          'credentials_on_unfamiliar_site',
        ),
      ],
    };
  }
  // Reaching here *is* the evidence: `pageMoved` has just proven the page
  // really moved, which is CONTEXT.md's definition of `confirmed` ("点击且页面
  // 确实变了"). Nothing else in this file may write that value.
  const moved: ThreadState = {
    ...state,
    table: input.table,
    // Spent: the check belongs to the hop that crossed, not to every page
    // after it. Whatever the user does next is on a site they have now chosen.
    crossedTo: undefined,
    history: stamp(state.history, 'confirmed', input.table.url),
    // The one moment the arrival can be judged: a fresh table of the page
    // the step led to. No `expect` means the model declined to predict, and
    // `'skipped'` says exactly that.
    check: state.expect ? judgeArrival(state.expect, input.table) : 'skipped',
  };
  // A call is already out against the page the user has just left. Record the
  // move and spend nothing: E-3 discards that result when it lands, because
  // the world no longer matches, and replans against this table instead.
  //
  // Recording it is the whole point, and this branch used to return `state`
  // untouched. E-3's world check compares the dispatched `at` against
  // `state.table` — so a table that never moved made a result computed for the
  // *previous* page look perfectly current. E-3 stayed silent, the stale
  // envelope was accepted, and a step belonging to a page the user had already
  // left was painted on screen: L-4, this product's only hard zero. Measured
  // on github.com over 15 live journeys, 13 of them stalled on exactly this —
  // the guide re-proposed the search box on the search *results* page, could
  // not bind it, and stopped.
  if (state.inflight) return { state: moved, effects: [] };

  return tryEmitCallModel(moved, input.effectId, nextRev);
}

function dispatch(state: ThreadState | null, input: MachineInput, nextRev: number): StepOut {
  if (input.kind === 'start') return handleStart(input, nextRev);
  if (!state) throw new Error(`machine.ts: no thread to apply a "${input.kind}" input to`);
  switch (input.kind) {
    case 'effect_result':
      return handleEffectResult(state, input, nextRev);
    case 'host_signal':
      return handleHostSignal(state, input);
    case 'step_settle_timeout':
      return handleStepSettleTimeout(state);
    case 'cross_site_decision':
      return handleCrossSiteDecision(state, input);
    case 'bind_result':
      return handleBindResult(state, input);
    case 'page_changed':
      return handlePageChanged(state, input, nextRev);
  }
}

/**
 * The single entry point (03-machine-reducer.md Seam). `state === null`
 * means "no thread yet" and is only ever valid alongside `input.kind ===
 * 'start'` — every other input requires a caller that already has a
 * `ThreadState` to hand back in (from `decodeThread`, or from this
 * function's own previous return).
 *
 * `rev` is entirely this wrapper's concern: every call increments it by
 * exactly one relative to the incoming state, unconditionally — including
 * calls that end up changing nothing else (slice 2's inflight-blocked
 * rejection still returns `rev + 1`). Handlers below never touch `rev`
 * themselves; only `nextRev`, computed once here and threaded down, so a
 * newly-dispatched effect's `inflight.at.threadRev` always matches the state
 * it is about to be persisted alongside.
 */
export function step(state: ThreadState | null, input: MachineInput): { state: ThreadState; effects: MachineEffect[] } {
  const nextRev = (state?.rev ?? 0) + 1;
  const result = dispatch(state, input, nextRev);
  return { state: { ...result.state, rev: nextRev }, effects: result.effects };
}
