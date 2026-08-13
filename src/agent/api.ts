import type { PromptTable } from '@/core/extractor/types';
import { MAX_CANDIDATES, rankCandidates } from '@/core/locator/lexical';
import { descriptorOf } from '@/core/packs/bind';
import { matchFlow } from '@/core/packs/match';
import { type GuideStep, type HighlightMode, type SessionId, actionForRole } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/**
 * ★ The single boundary between step 1 and the agent.
 *
 * Step 2 implements LangGraph, providers and a checkpoint saver *inside this
 * file*. Callers do not change.
 *
 * The previous signature was `resolve(req): Promise<ResolveResult>`, and it
 * could not survive that move for four independent reasons:
 *
 *  1. **A promise resolves once, and `guide` is N interrupts.** One call cannot
 *     express "show step 1, wait for the user, show step 2". That it appeared to
 *     work was an illusion created by putting the cursor in the content script —
 *     the wrong owner. Fixing ownership (task 11) and fixing this signature are
 *     the same fix seen from two directions.
 *  2. **No outlet for streaming.** `AbortSignal` bought cancellation, not
 *     progressive output.
 *  3. **The worker's 30 s fetch ceiling needs observable progress** to drive a
 *     keep-alive. During `await resolve()` the host knew nothing.
 *  4. **`intent` was frozen into a cross-module contract**, while §9 says the
 *     intent enum must stay soft.
 *
 * `AsyncIterable` + a separate `resume` is 1:1 with LangGraph's
 * `graph.stream(input, cfg)` / `graph.stream(new Command({resume}), cfg)`, so
 * step 2 needs no adapter layer. A stream **ends** at `await_user`; resuming
 * starts a new one. That is exactly what `interrupt()` does.
 */
export type AgentSource = 'pack' | 'baseline' | 'model';

/** K-9: one live session per tab, and the checkpoint thread is that session. */
export type ThreadId = SessionId;

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StartInput {
  threadId: ThreadId;
  url: string;
  table: PromptTable;
  contextWindow: number;
  locale: string;
  /** What the user asked for. The only input step 2 will use. */
  goal?: string;
  /** A ready-made flow, from the element inspector. Skips resolution entirely —
   *  a step-1 affordance, not something a model will ever produce. */
  steps?: readonly GuideStep[];
}

/**
 * Everything that can move a thread forward, from the user *or* from the
 * renderer. The renderer's report is in here on purpose: whether a step could
 * be pointed at is evidence the flow owner needs, and routing it through the
 * same door keeps the decision in one place.
 */
export type HostSignal =
  | { kind: 'confirmed' }
  | { kind: 'skipped' }
  /** The page navigated. Usually means the user did exactly what we asked. */
  | { kind: 'navigated'; url: string }
  /** Same URL again — a reload is not progress. */
  | { kind: 'reloaded' }
  /** The renderer could not find the current step's target. */
  | { kind: 'unresolved' };

export type AgentEvent =
  | { kind: 'phase'; phase: 'preroute' | 'pack' | 'extract' | 'resolve' | 'relocate' }
  | { kind: 'delta'; text: string }
  | { kind: 'answer'; text: string; refs: readonly Ref[] }
  | { kind: 'show'; step: GuideStep; index: number; total: number; mode: HighlightMode; snapshotId: string }
  /** Where `interrupt()` lands. The stream ends here. */
  | { kind: 'await_user'; index: number }
  | { kind: 'usage'; usage: TokenUsage; source: AgentSource }
  | { kind: 'error'; message: string; retryable: boolean; index: number; total: number }
  | { kind: 'done'; reason: 'completed' | 'aborted' | 'expired' | 'failed' };

export interface AgentHost {
  start(input: StartInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  resume(threadId: ThreadId, report: HostSignal, signal: AbortSignal): AsyncIterable<AgentEvent>;
  abort(threadId: ThreadId): Promise<void>;
}

/* ═══════════ step-1 implementation ═══════════ */

interface Thread {
  steps: GuideStep[];
  cursor: number;
  url: string;
  /** The snapshot the refs in `steps` came from. Lets the renderer take its
   *  fast path while the page is unchanged; stale is harmless, it just rebinds. */
  snapshotId: string;
  /**
   * We advanced because the URL changed, not because the user told us to. If
   * the next step turns out not to be on this page, step back — "the user
   * navigated" is not proof of "the user did what we asked".
   */
  speculative: boolean;
  /**
   * The user just told us they finished a step. If a navigation follows, it is
   * the *consequence* of that same action — they clicked the link we pointed at
   * — not fresh evidence of a second step being done. Counting both advanced
   * the flow twice and finished a two-step guide before its second step was
   * ever shown.
   */
  justConfirmed?: boolean;
}

const keyFor = (id: ThreadId) => `thread:${id}`;

/**
 * The thread lives in `chrome.storage.session`, not in a module variable.
 *
 * The worker is evicted after 30 s idle, which is far shorter than a user
 * reading one step — and eviction also kills any generator mid-flight. In step 2
 * the LangGraph checkpoint takes this over; until then this record *is* the
 * checkpoint, which is why `resume` reads it back rather than closing over it.
 */
async function load(id: ThreadId): Promise<Thread | null> {
  const k = keyFor(id);
  return ((await chrome.storage.session.get(k))[k] as Thread | undefined) ?? null;
}
const save = (id: ThreadId, t: Thread) => chrome.storage.session.set({ [keyFor(id)]: t });
const drop = (id: ThreadId) => chrome.storage.session.remove(keyFor(id));

/** Emits the step at `cursor`, then parks. Both halves of one interrupt. */
async function* present(thread: Thread, mode: HighlightMode): AsyncGenerator<AgentEvent> {
  const step = thread.steps[thread.cursor];
  if (!step) {
    yield { kind: 'done', reason: 'completed' };
    return;
  }
  yield { kind: 'show', step, index: thread.cursor, total: thread.steps.length, mode, snapshotId: thread.snapshotId };
  yield { kind: 'await_user', index: thread.cursor };
}

class StepOneHost implements AgentHost {
  async *start(input: StartInput, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (signal.aborted) return yield { kind: 'done', reason: 'aborted' };

    // Path 0 — a flow handed to us whole (element inspector).
    if (input.steps?.length) {
      const thread: Thread = {
        steps: [...input.steps],
        cursor: 0,
        url: input.url,
        snapshotId: input.table.snapshotId,
        speculative: false,
      };
      await save(input.threadId, thread);
      yield* present(thread, 'locate');
      return;
    }

    yield { kind: 'phase', phase: 'preroute' };
    const goal = input.goal ?? '';

    // Path 1 — guide pack. Zero cost, full multi-step guide.
    yield { kind: 'phase', phase: 'pack' };
    const hit = matchFlow(input.url, goal);
    if (hit) {
      // Descriptors only: step 3's target is typically not in the DOM while
      // step 1 is on screen, so nothing here can produce a ref for it. The
      // renderer binds each step at the moment it shows it (task 8).
      const steps: GuideStep[] = hit.flow.steps.map((ps) => ({
        descriptor: ps.target,
        expectedUserAction: ps.expectedUserAction,
        title: ps.title,
        detail: ps.detail,
      }));
      const thread: Thread = {
        steps,
        cursor: 0,
        url: input.url,
        snapshotId: input.table.snapshotId,
        speculative: false,
      };
      await save(input.threadId, thread);
      yield* present(thread, 'guide');
      return;
    }

    // Path 2 — local lexical baseline. Also the M0-b lower bound.
    yield { kind: 'phase', phase: 'resolve' };
    const ranked = rankCandidates(goal, input.table.items);

    if (ranked.kind === 'none') {
      yield {
        kind: 'answer',
        text: '在当前页面上没有找到与描述匹配的控件。换个说法，或先滚动到目标所在区域。',
        refs: [],
      };
      yield { kind: 'done', reason: 'completed' };
      return;
    }

    if (ranked.kind === 'ambiguous' && ranked.items.length > MAX_CANDIDATES) {
      // Deviation from §7 of the plan, which said "≥4 → lost screen". A lost
      // screen reads "找不到这一步的目标", and saying that after finding seven
      // matches is a lie in the direction that makes the user distrust the
      // product. The actionable answer is to rephrase, and rephrasing happens
      // in the panel, not on the page.
      yield {
        kind: 'answer',
        text: `本页有 ${ranked.items.length} 个控件都符合「${goal}」，说得更具体一些（例如加上所在区块）。`,
        refs: ranked.items.map((i) => i.ref),
      };
      yield { kind: 'done', reason: 'completed' };
      return;
    }

    // 2–3 near-ties: outline every one and let the user judge. The multi-hole
    // mask already exists for `explain`, so this costs nothing to render.
    const step: GuideStep =
      ranked.kind === 'unique'
        ? {
            ref: ranked.item.ref,
            descriptor: descriptorOf(ranked.item),
            expectedUserAction: actionForRole(ranked.item.role),
            title: ranked.item.name || ranked.item.role,
            detail: `本地词法基线匹配（${ranked.signals.join(', ')}），未调用模型。`,
          }
        : {
            // The *weakest* descriptor on purpose — the one that matches all of
            // them. Carrying `alsoRefs` instead would tie this step to the
            // snapshot it was born in, and refs cannot be rebound, so the step
            // would die at the first navigation. A descriptor that is honestly
            // ambiguous survives; the renderer re-derives the same candidates
            // against whatever page it is looking at.
            descriptor: { role: ranked.items[0]!.role, name: ranked.items[0]!.name },
            expectedUserAction: actionForRole(ranked.items[0]!.role),
            title: `${ranked.items.length} 个候选`,
            detail: '这些控件与你的描述同样接近，请按说明判断该点哪一个。',
          };

    const thread: Thread = {
      steps: [step],
      cursor: 0,
      url: input.url,
      snapshotId: input.table.snapshotId,
      speculative: false,
    };
    await save(input.threadId, thread);
    yield* present(thread, 'locate');
  }

  async *resume(
    threadId: ThreadId,
    report: HostSignal,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    if (signal.aborted) return yield { kind: 'done', reason: 'aborted' };

    const thread = await load(threadId);
    if (!thread) {
      // Nothing to resume: the worker was evicted *and* the record is gone, or
      // the guide already ended. Saying so beats silently doing nothing.
      yield { kind: 'done', reason: 'expired' };
      return;
    }

    const mode: HighlightMode = thread.steps.length > 1 ? 'guide' : 'locate';

    if (report.kind === 'unresolved') {
      if (thread.speculative && thread.cursor > 0) {
        // We guessed that the navigation completed the previous step. It did
        // not, so put the user back where they were rather than stranding them.
        const back: Thread = { ...thread, cursor: thread.cursor - 1, speculative: false };
        await save(threadId, back);
        yield* present(back, mode);
        return;
      }
      // Progress travels with the error: the panel was rendering "第 1 / 0 步"
      // because the host had nowhere to read it from and defaulted to zero.
      yield {
        kind: 'error',
        message: '找不到这一步的目标，页面可能已经变化。',
        retryable: true,
        index: thread.cursor,
        total: thread.steps.length,
      };
      return;
    }

    // A navigation right after a confirmation is that confirmation's aftermath.
    // Re-present the step we already advanced to, against the new page.
    if (report.kind === 'navigated' && thread.justConfirmed) {
      const settled: Thread = { ...thread, url: report.url, speculative: false, justConfirmed: false };
      await save(threadId, settled);
      yield* present(settled, mode);
      return;
    }

    if (report.kind === 'reloaded') {
      const same: Thread = { ...thread, speculative: false, justConfirmed: false };
      await save(threadId, same);
      yield* present(same, mode);
      return;
    }

    const next = thread.cursor + 1;
    if (next >= thread.steps.length) {
      await drop(threadId);
      yield { kind: 'done', reason: 'completed' };
      return;
    }

    const moved: Thread = {
      steps: thread.steps,
      cursor: next,
      url: report.kind === 'navigated' ? report.url : thread.url,
      snapshotId: thread.snapshotId,
      speculative: report.kind === 'navigated',
      justConfirmed: report.kind === 'confirmed',
    };
    await save(threadId, moved);
    yield* present(moved, mode);
  }

  async abort(threadId: ThreadId): Promise<void> {
    await drop(threadId);
  }
}

export const agentHost: AgentHost = new StepOneHost();

/** Readback for cross-page resume; not part of the long-term boundary. */
export const threadExists = async (id: ThreadId): Promise<boolean> => (await load(id)) !== null;
