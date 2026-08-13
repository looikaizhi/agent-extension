import { extract } from '@/core/extractor/extract';
import { fullTable, project } from '@/core/extractor/project';
import { registry } from '@/core/extractor/registry';
import { bindStep } from '@/core/packs/bind';
import { authorDescriptor, toPackYaml } from '@/core/packs/author';
import type { ExtractProfile, ProjectBudget, PromptItem, PromptTable } from '@/core/extractor/types';
import { Overlay } from '@/core/overlay/overlay';
import { scrollToTarget, TargetTracker } from '@/core/overlay/tracker';
import type {
  ContentRequest,
  ContentResponse,
  GuideStep,
  HighlightAck,
  HighlightCommand,
  HighlightFailure,
} from '@/shared/protocol';
import { emit, onRequest } from '@/shared/rpc';
import type { Rect, Ref } from '@/shared/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Static registration: Chrome injects this itself on every matching page, so
  // there is no runtime permission moment at all. `ensureInjected` still exists
  // for the two cases static registration cannot cover — the extension being
  // installed or reloaded while a page is already open, and a user who has set
  // this extension's site access to "on click" in chrome://extensions.
  runAt: 'document_idle',
  allFrames: false,
  main() {
    let overlay: Overlay | null = null;
    let tracker: TargetTracker | null = null;
    /** The one step currently on screen. There is no flow here, by design. */
    let current: HighlightCommand | null = null;
    let off: (() => void) | null = null;

    /**
     * Two instances can legitimately land in one page: Chrome injects this
     * statically at `document_idle`, while `ensureInjected` may have injected it
     * moments earlier against a page that was not ready yet (and does so again
     * after an extension reload). They own separate `registry` generations, so
     * whichever answered a message first would hand out refs the other cannot
     * resolve — EXTRACT to A, HIGHLIGHT to B, `snapshot_stale` forever.
     *
     * Newest wins: greet the incumbent by shutting it down. Both instances share
     * one isolated world, so this hook is reachable and invisible to the page.
     */
    const SHUTDOWN = '__pageGuideShutdown';
    type Shared = Window & { [SHUTDOWN]?: () => void };
    (window as Shared)[SHUTDOWN]?.();
    (window as Shared)[SHUTDOWN] = () => {
      off?.();
      stopInspect();
      teardown();
      overlay?.destroy();
      overlay = null;
    };

    const ensureOverlay = (): Overlay => {
      overlay ??= new Overlay({
        // The renderer reports what the user did and stops there. Choosing the
        // next step is the flow owner's job — this process does not survive a
        // navigation, so it must not hold anything it cannot rebuild.
        onNext: () => report('STEP_CONFIRMED'),
        onSkip: () => report('STEP_SKIPPED'),
        onExit: () => {
          if (current) emit({ type: 'SESSION_ENDED', sessionId: current.sessionId, reason: 'user_closed' });
          teardown();
        },
        onRetry: () => void render(),
      });
      return overlay;
    };

    function report(type: 'STEP_CONFIRMED' | 'STEP_SKIPPED'): void {
      if (!current) return;
      emit({ type, sessionId: current.sessionId, stepIndex: current.progress.index });
    }

    /** Removes the activation listener for the step currently on screen. */
    let unwatchActivation: (() => void) | null = null;

    function teardown(): void {
      unwatchActivation?.();
      unwatchActivation = null;
      stopWatching();
      tracker?.detach();
      tracker = null;
      overlay?.hide();
      current = null;
    }

    const failed = (failure: HighlightFailure): ContentResponse<'HIGHLIGHT'> => ({
      ok: true,
      data: { resolved: null, rect: null, scrolled: false, failure },
    });

    /**
     * Late binding — the heart of task 8, and the only interface an agent can
     * actually use.
     *
     * A `ref` names an element *in one snapshot of one page at one moment*. Step
     * 3's target usually does not exist in the DOM while step 1 is on screen
     * (a dialog has not opened, a page has not been navigated to), so no caller
     * — pack, baseline or model — can produce a ref for it up front. What it can
     * produce is a `descriptor`, and turning that into a ref is only possible
     * here, now, against the live page.
     *
     * That also fixes F-7 for free: "重试定位" used to re-resolve the same dead
     * handle and necessarily fail again, while the descriptor sat unread in the
     * same object.
     */
    function bindHere(step: GuideStep): { el: Element | null; also: Element[]; refs: readonly Ref[] } {
      const view = extract(lastProfile);
      const table = fullTable(view, lastBudget);
      // Recomputed from the fresh full set, so S-03 can never be evaluated
      // against a stale — or narrower — view of the page.
      sensitiveRefs = new Set(table.items.filter((i) => i.sensitive).map((i) => i.ref));

      const bound = bindStep(step.descriptor, table);
      if (bound.kind === 'not_found') return { el: null, also: [], refs: [] };
      if (bound.kind === 'unique') {
        return { el: registry.resolve(view.snapshotId, bound.ref), also: [], refs: [bound.ref] };
      }
      // Several matches and no way to choose between them (K-6). Every one gets
      // outlined; picking would be the silent mis-point this design exists to
      // prevent.
      const els = bound.refs
        .map((r) => registry.resolve(view.snapshotId, r))
        .filter((x): x is Element => x !== null);
      return { el: null, also: els, refs: bound.refs };
    }

    /**
     * Returns whether anything was actually put on screen, not just whether it
     * succeeded. The lost screen is a *rendered* state — it carries the only
     * buttons the user has at that moment — so the command that produced it has
     * to stay adopted. Reverting it left the overlay showing a step the content
     * script no longer remembered, and 下一步 / 跳过 / 结束 all silently did
     * nothing. Only a refusal that paints nothing may leave no trace.
     */
    async function render(): Promise<{ res: ContentResponse<'HIGHLIGHT'>; painted: boolean }> {
      const cmd = current;
      if (!cmd) return { res: failed('ref_not_found'), painted: false };
      const step = cmd.step;

      // Fast path: the handle is still valid, so use it. `registry.resolve`
      // carries R-04's snapshot guard itself, so a stale handle simply yields
      // null and falls through to rebinding rather than being refused.
      let el = step.ref ? registry.resolve(cmd.snapshotId, step.ref) : null;
      let resolved: Ref | null = el ? step.ref! : null;
      let also = (step.alsoRefs ?? [])
        .map((r) => registry.resolve(cmd.snapshotId, r))
        .filter((x): x is Element => x !== null);
      let candidates: readonly Ref[] | undefined;

      // `alsoRefs` carry no descriptor of their own, so they cannot be rebound.
      // Dropping the dead ones silently would paint fewer highlights than the
      // caller asked for, and the caller would never know.
      const declared = step.alsoRefs ?? [];
      if (declared.length > 0 && also.length !== declared.length) return { res: failed('snapshot_stale'), painted: false };

      if (!el) {
        if (declared.length > 0) {
          // The caller named the set explicitly — `explain` / `diagnose`, or a
          // step already known to be ambiguous. Honour it; rebinding here would
          // silently substitute our own idea of the target for theirs.
          candidates = declared;
        } else {
          const rebound = bindHere(step);
          el = rebound.el;
          resolved = rebound.el ? rebound.refs[0]! : null;
          if (!rebound.el && rebound.also.length > 0) {
            also = rebound.also;
            candidates = rebound.refs;
          }
        }
      }

      // S-03, second and independent enforcement point: a hand-written pack is
      // blocked exactly like a model would be. It sits in front of every paint,
      // and covers *every* ref the step can put on screen — `alsoRefs` cuts a
      // hole in the scrim just as `ref` does, and it is the path `explain` /
      // `diagnose` will take (F-1). Evaluated after binding, because binding is
      // what decides which refs are actually involved.
      if (sensitiveOf([...(resolved ? [resolved] : []), ...(candidates ?? step.alsoRefs ?? [])]))
        return { res: failed('sensitive_blocked'), painted: false };

      const ui = ensureOverlay();
      ui.setStep(view(cmd));

      if (!el) {
        if (also.length > 0) {
          attachTracker(ui, also[0]!, also.slice(1), step, 'ambiguous');
          return {
            res: { ok: true, data: { resolved: null, rect: rectOf(also[0]!), scrolled: false, candidates } },
            painted: true,
          };
        }
        ui.paint([], 'lost');
        // Painted: the user is looking at the lost screen right now.
        return { res: failed('ref_not_found'), painted: true };
      }

      const scrolled = cmd.autoScroll ? await scrollToTarget(el) : false;
      // `current` may have been cleared while we awaited the scroll.
      if (current !== cmd) return { res: failed('ref_not_found'), painted: false };

      attachTracker(ui, el, also, step, 'shown');
      return { res: { ok: true, data: { resolved, rect: rectOf(el), scrolled } }, painted: true };
    }

    function attachTracker(
      ui: Overlay,
      el: Element,
      also: Element[],
      step: GuideStep,
      initial: 'shown' | 'ambiguous',
    ): void {
      tracker?.detach();
      tracker = new TargetTracker({
        paint: (rects, status) => ui.paint(rects, initial === 'ambiguous' ? 'ambiguous' : status),
        onLost: (reason) => {
          ui.paint([], 'lost');
          // Read from `current`, never from a captured step: one tracker used to
          // be built for the whole flow and reported step 0's ref forever.
          const ref = current?.step.ref ?? step.ref;
          if (current && ref) emit({ type: 'TARGET_LOST', sessionId: current.sessionId, ref, reason });
        },
        isOccluded: (t) => ui.isOccluded(t),
      });
      tracker.attach(el, also);

      // Watch the target being used. The card's 「下一步」 stays, but a user who
      // does exactly what we asked should not then have to tell us they did —
      // the page already said so.
      //
      // §2.3 U-03 says "不自动跳步", and this does not break it: the rule exists
      // to stop the guide advancing on *no* evidence. Advancing on the evidence
      // of the actual click is the opposite of that.
      //
      // Listening is not acting. The listener is passive and never cancels.
      unwatchActivation?.();
      if (ADVANCING_ACTIONS.has(step.expectedUserAction)) {
        const onActivate = () => report('STEP_CONFIRMED');
        el.addEventListener('click', onActivate, { capture: true, once: true, passive: true });
        unwatchActivation = () => el.removeEventListener('click', onActivate, { capture: true });
      }
    }

    /** Clicking is completion for these; for `input` / `observe` it is not. */
    const ADVANCING_ACTIONS = new Set(['click', 'toggle', 'select']);

    /**
     * A lost step is not a dead end — it is a step whose target has not appeared
     * *yet*. The user has just been told to open a menu, so the very next thing
     * that happens is the DOM changing. Sitting still through that is why the
     * guide looked frozen: it only ever reacted to its own buttons.
     */
    let lostWatch: (() => void) | null = null;

    function stopWatching(): void {
      lostWatch?.();
      lostWatch = null;
    }

    /**
     * Backoff, *and* mutations — not mutations alone.
     *
     * The first version only retried when the DOM changed, which sounds
     * sufficient and is not: a page that has just finished loading produces no
     * mutations at all. The host would render one step into a page that was a
     * few milliseconds from being ready, get `ref_not_found`, and nothing would
     * ever try again. That was a hard-reproducible failure of the cross-page
     * guide, not a flake — it only ever "passed" when instrumentation happened
     * to add a millisecond of delay.
     *
     * Mutations still matter: on an SPA they are what says "the menu opened",
     * and reacting to them is far faster than waiting out the schedule.
     */
    const RETRY_MS = [250, 500, 900, 1500, 2500, 4000, 6000];

    function watchForTarget(): void {
      if (lostWatch) return; // already watching this step
      let attempt = 0;
      let timer = 0;
      let stopped = false;

      const schedule = (delay?: number) => {
        if (stopped || timer) return;
        if (attempt >= RETRY_MS.length) return stopWatching();
        timer = setTimeout(attemptBind, delay ?? RETRY_MS[attempt++]!) as unknown as number;
      };

      const attemptBind = () => {
        timer = 0;
        if (stopped || !current) return stopWatching();
        void render().then(({ res }) => {
          if (stopped) return;
          if (res.ok && !res.data.failure) {
            const found = current;
            stopWatching();
            if (found && res.data.resolved)
              emit({ type: 'TARGET_FOUND', sessionId: found.sessionId, ref: res.data.resolved });
            return;
          }
          schedule();
        });
      };

      // A mutation only pulls the next attempt forward; it never buys extra
      // attempts, so a page that churns constantly cannot keep us extracting.
      const mo = new MutationObserver(() => {
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }
        schedule(200);
      });
      mo.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'hidden', 'aria-hidden', 'class', 'style'],
      });

      lostWatch = () => {
        stopped = true;
        mo.disconnect();
        if (timer) clearTimeout(timer);
      };
      schedule();
    }

    const rectOf = (el: Element): Rect => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };

    function view(cmd: HighlightCommand) {
      const d = cmd.step.descriptor;
      return {
        index: cmd.progress.index,
        total: cmd.progress.total,
        title: cmd.step.title,
        detail: cmd.step.detail,
        looking: `找的是：${d.role}｜${d.name}${d.scope ? `（在「${d.scope}」内）` : ''}${d.nth !== undefined ? `（第 ${d.nth} 个）` : ''}`,
      };
    }

    let sensitiveRefs = new Set<string>();
    /** Whether any ref about to be painted is a sensitive field. */
    const sensitiveOf = (refs: readonly Ref[]): boolean => refs.some((r) => sensitiveRefs.has(r));

    // Binding needs the same lens the caller extracted through, so the profile
    // and budget of the last EXTRACT are remembered rather than guessed.
    let lastProfile: ExtractProfile = 'interactive';
    let lastBudget: ProjectBudget = { maxNodes: 150, viewportBands: 1 };

    /* ═══════════ authoring: pick an element, get a descriptor ═══════════ */

    let inspecting: { table: PromptTable; byEl: Map<Element, PromptItem>; stop: () => void } | null =
      null;

    /** Nearest ancestor (across shadow boundaries) that we actually extracted. */
    const itemAt = (x: number, y: number): { el: Element; item: PromptItem } | null => {
      if (!inspecting) return null;
      let el: Element | null = document.elementFromPoint(x, y);
      for (let guard = 0; el && guard < 40; guard++) {
        const item = inspecting.byEl.get(el);
        if (item) return { el, item };
        const parent: Element | null =
          el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
        el = parent;
      }
      return null;
    };

    function startInspect(): void {
      stopInspect();
      const view = extract(lastProfile);
      const table = fullTable(view, lastBudget);
      const byEl = new Map<Element, PromptItem>();
      for (const item of table.items) {
        const el = registry.resolve(view.snapshotId, item.ref);
        if (el) byEl.set(el, item);
      }

      const ui = ensureOverlay();
      const onMove = (e: PointerEvent) => {
        const hit = itemAt(e.clientX, e.clientY);
        ui.outline(hit ? rectOf(hit.el) : null);
      };
      // Capture phase and cancelled: the author is pointing at a control, and
      // letting the click through would navigate away from the page they are
      // annotating. This is the one place we touch an event the page wanted —
      // and we swallow it rather than replay it.
      const onClick = (e: MouseEvent) => {
        const hit = itemAt(e.clientX, e.clientY);
        e.preventDefault();
        e.stopPropagation();
        stopInspect();
        if (!hit) return;
        const authored = authorDescriptor(hit.item, table);
        emit({
          type: 'ELEMENT_PICKED',
          descriptor: authored.descriptor,
          label: `${hit.item.role}｜${hit.item.name}`,
          matches: authored.matches,
          correct: authored.correct,
          rung: authored.rung,
          yaml: toPackYaml(authored, hit.item.name || hit.item.role),
        });
      };
      addEventListener('pointermove', onMove, true);
      addEventListener('click', onClick, true);
      inspecting = {
        table,
        byEl,
        stop: () => {
          removeEventListener('pointermove', onMove, true);
          removeEventListener('click', onClick, true);
          ui.outline(null);
        },
      };
    }

    function stopInspect(): void {
      inspecting?.stop();
      inspecting = null;
    }

    off = onRequest(async (req: ContentRequest): Promise<ContentResponse> => {
      switch (req.type) {
        case 'PING':
          return { ok: true, data: { version: '0.1.0', frameId: 0, title: document.title } };

        case 'EXTRACT': {
          lastProfile = req.profile;
          lastBudget = req.budget;
          const view = extract(req.profile);
          // Sensitivity is tracked over the *full* set, not the projected one:
          // a password field pruned for being off screen is still a password
          // field, and late binding can reach it.
          sensitiveRefs = new Set(
            fullTable(view, req.budget)
              .items.filter((i) => i.sensitive)
              .map((i) => i.ref),
          );
          return { ok: true, data: project(view, req.budget) };
        }

        case 'HIGHLIGHT': {
          // A refusal that painted nothing must leave no trace — adopting it
          // would keep a blocked step reachable through "重试定位". But a lost
          // screen *is* painted, and the command behind it must stay adopted or
          // its buttons report nothing.
          //
          // `current === mine` is the reentrancy guard, and it is load-bearing.
          // `render()` awaits `scrollToTarget` for up to 800 ms, and the host
          // legitimately sends two commands in a row after a navigation (the
          // step the user confirmed, then the same step replayed against the new
          // page). Without the guard the *older* render would wake up and
          // restore its own `previous`, wiping out the newer command — so both
          // renders then failed their own `current !== cmd` check and the guide
          // silently died on exactly the transition it exists to handle.
          const previous = current;
          const mine = req.command;
          current = mine;
          const { res, painted } = await render();
          if (!painted && current === mine) current = previous;
          // Keep looking while the step is on screen but unresolved.
          if (painted && res.ok && res.data.failure === 'ref_not_found') watchForTarget();
          else stopWatching();
          return res;
        }

        case 'INSPECT':
          if (req.on) startInspect();
          else stopInspect();
          return { ok: true, data: null };

        case 'CLEAR':
          stopInspect();
          teardown();
          return { ok: true, data: null };

        case 'DEBUG_GET_OVERLAY_STATE':
          return { ok: true, data: overlay ? overlay.getState() : null };
      }
    });

    addEventListener('pagehide', () => {
      if (current) emit({ type: 'SESSION_ENDED', sessionId: current.sessionId, reason: 'navigated' });
    });
  },
});
