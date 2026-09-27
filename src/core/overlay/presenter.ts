import type { ContentEvent, ContentResponse, GuideStep, HighlightCommand, HighlightFailure } from '@/shared/protocol';
import { sameView } from '@/shared/view';
import type { Ref } from '@/shared/types';
import { checkActionability } from './actionability';
import type { PresenterDom } from './dom';
import type { Overlay } from './overlay';

/** The part of the overlay a presenter draws on. */
type Screen = Pick<Overlay, 'setStep' | 'paint' | 'isOccluded'>;

/**
 * What the presenter borrows from the content script that owns the page.
 *
 * The overlay, extraction and the sensitive-field set are shared with
 * authoring and with `EXTRACT`, so they stay where they are and are lent here
 * rather than moved. Messages go out through a port as well: nothing under
 * `core/` talks to the extension runtime itself. The page's primitives come in
 * as `dom`, so everything this file decides can be run without a page.
 */
export interface PresenterPorts {
  /** The overlay, created on first use. */
  overlay(): Screen;
  /** Late binding: turn the step's descriptor into elements on the live page, now. */
  bind(step: GuideStep): { el: Element | null; also: Element[]; refs: readonly Ref[] };
  /** Whether any ref about to be painted is a sensitive field. */
  isSensitive(refs: readonly Ref[]): boolean;
  emit(event: ContentEvent): void;
  dom: PresenterDom;
}

/**
 * The step on screen and everything that keeps it there: the highlight, the
 * watch for a target that is not on the page, and the one look at whether the
 * target can be operated.
 *
 * Each of those belongs to one CONTEXT.md `Presentation`, named by the host.
 * A command with the same `presentationId` is that presentation painted again;
 * a different one that reaches the screen ends everything the previous one
 * left running. Nothing here makes an id up, so nothing here can start a
 * presentation the host did not ask for.
 *
 * Nothing here runs on a timer. Whether the page has settled is not a question
 * this product answers (CONTEXT.md `Reading`): what the renderer finds is
 * reported as it finds it, and waiting is the model's to ask for.
 */
export interface Presenter {
  /** The one step currently on screen. There is no flow here, by design. */
  readonly current: HighlightCommand | null;
  /** The element the current step is pointing at, for 「跳到目标」 to hand the keyboard to. */
  readonly target: Element | null;
  /** Whether a missing target is being looked for as the page changes, and how
   *  many looks the latest watch has taken. Read back for the e2e suite
   *  (`DEBUG_GET_OVERLAY_STATE`): when a target that came back is not picked
   *  up, this says whether the page was looked at at all. */
  readonly watch: { watching: boolean; looks: number };
  show(command: HighlightCommand): Promise<ContentResponse<'HIGHLIGHT'>>;
  retry(): void;
  teardown(): void;
}

export function createPresenter(ports: PresenterPorts): Presenter {
  const { dom } = ports;
  let tracker: { detach(): void } | null = null;
  /** The element the current step is pointing at, for `onNext` to hand the
   *  keyboard to. Kept beside `tracker` because both are per-step and both
   *  are cleared by `teardown`. */
  let target: Element | null = null;
  /** The presentation the tracker, the activation listener and `target` belong to. */
  let trackedFor = '';
  /** The one step currently on screen. There is no flow here, by design. */
  let current: HighlightCommand | null = null;

  /** Removes the activation listener for the step currently on screen. */
  let unwatchActivation: (() => void) | null = null;

  function stopTracking(): void {
    unwatchActivation?.();
    unwatchActivation = null;
    tracker?.detach();
    tracker = null;
    target = null;
  }

  /** The actionability check still looking, and the presentation it was
   *  started for — at most one check per presentation, ever. */
  let stopChecking: (() => void) | null = null;
  let checkedFor = '';

  function stopCheck(): void {
    stopChecking?.();
    stopChecking = null;
  }

  /**
   * Everything ends, including what was already said: a presentation id is
   * the host's count of steps within one run (`threadId#n`), so the next run
   * on this tab numbers its steps from the start again — and its first step is
   * not the one this presenter already reported on.
   */
  function teardown(): void {
    stopTracking();
    stopCheck();
    stopWatching();
    checkedFor = '';
    reportedMissing = '';
    current = null;
  }

  /**
   * A presentation is taking the screen: whatever a different one left running
   * ends here, rather than speaking later in the new one's name.
   *
   * Called at the moment a render commits to painting — every refusal already
   * returned. Painting 「找不到」 replaces none of the previous tracker or
   * listener, which is how the previous target's click came to be reported as
   * this step done and its disappearance as this step lost. The same
   * presentation painted again keeps what it has.
   */
  function retireAllBut(owner: string): void {
    if ((tracker || unwatchActivation) && trackedFor !== owner) stopTracking();
    if (stopChecking && checkedFor !== owner) stopCheck();
    if (lostWatch && watchingFor !== owner) stopWatching();
  }

  const failed = (failure: HighlightFailure): ContentResponse<'HIGHLIGHT'> => ({
    ok: true,
    data: { resolved: null, rect: null, failure },
  });

  /**
   * Returns whether anything was actually put on screen, not just whether it
   * succeeded. The lost screen is a *rendered* state — it carries the only
   * buttons the user has at that moment — so the command that produced it has
   * to stay adopted. Reverting it left the overlay showing a step the content
   * script no longer remembered, and 跳到目标 / 跳过 / 结束 all silently did
   * nothing. Only a refusal that paints nothing may leave no trace.
   *
   * Synchronous, all the way: nothing between deciding and painting waits, so
   * no newer command can arrive in between.
   */
  function render(): { res: ContentResponse<'HIGHLIGHT'>; painted: boolean } {
    const cmd = current;
    if (!cmd) return { res: failed('ref_not_found'), painted: false };
    const step = cmd.step;

    // Which page this is comes first, and from the address alone (CONTEXT.md
    // `View`). A step drawn from another page is not painted here, and not
    // looked for either: rebinding its descriptor on this page would find
    // whatever happens to match, and paint it as confidently as the original.
    // The snapshot below cannot answer this — a same-document navigation keeps
    // it current and its elements connected.
    if (!sameView(cmd.view, dom.view())) return { res: failed('view_moved'), painted: false };

    // Fast path: the handle is still fresh, so use it. `registry.resolve`
    // carries R-04's snapshot guard itself — freshness, not identity — so a
    // stale handle simply yields null and falls through to rebinding.
    let el = step.ref ? dom.resolve(cmd.snapshotId, step.ref) : null;
    let resolved: Ref | null = el ? step.ref! : null;
    let also = (step.alsoRefs ?? [])
      .map((r) => dom.resolve(cmd.snapshotId, r))
      .filter((x): x is Element => x !== null);
    let candidates: readonly Ref[] | undefined;

    // `alsoRefs` carry no descriptor of their own, so they cannot be rebound.
    // Dropping the dead ones silently would paint fewer highlights than the
    // caller asked for, and the caller would never know.
    const declared = step.alsoRefs ?? [];
    if (declared.length > 0 && also.length !== declared.length) return { res: failed('snapshot_stale'), painted: false };

    if (!el) {
      if (declared.length > 0) {
        // The caller named the set explicitly — `explain`, or a step already
        // known to be ambiguous. Honour it; rebinding here would silently
        // substitute our own idea of the target for theirs.
        candidates = declared;
      } else if (cmd.mode === 'explain') {
        // What backs an answer is a point-in-time assertion ("the one I read
        // just then"), not a durable intent like a guide Step. Rebinding by
        // descriptor here would silently swap in whatever element happens to
        // match now — right role, right name, wrong moment — and paint it with
        // the same confidence as the original, which is the exact shape of
        // L-4. So `explain` trusts only the snapshot it was given: if the fast
        // path above did not resolve, the snapshot is stale — full stop, not
        // "let's go look again". This must not fall through to the lost screen
        // below either: that screen means "never found it", `snapshot_stale`
        // means "found it once, not anymore" — a different fact than the
        // renderer owes the user a different way.
        return { res: failed('snapshot_stale'), painted: false };
      } else {
        const rebound = ports.bind(step);
        el = rebound.el;
        resolved = rebound.el ? rebound.refs[0]! : null;
        if (!rebound.el && rebound.also.length > 0) {
          also = rebound.also;
          candidates = rebound.refs;
        }
      }
    }

    // S-03, second and independent enforcement point: a hand-written fixed plan is
    // blocked exactly like a model would be. It sits in front of every paint,
    // and covers *every* ref the step can put on screen — `alsoRefs` cuts a
    // hole in the scrim just as `ref` does, and it is the path `explain` takes
    // (F-1). Evaluated after binding, because binding is what decides which
    // refs are actually involved.
    if (ports.isSensitive([...(resolved ? [resolved] : []), ...(candidates ?? step.alsoRefs ?? [])]))
      return { res: failed('sensitive_blocked'), painted: false };

    retireAllBut(cmd.presentationId);
    const ui = ports.overlay();
    ui.setStep(view(cmd));

    if (!el) {
      if (also.length > 0) {
        attachTracker(ui, also[0]!, also.slice(1), step, 'ambiguous', cmd);
        return { res: { ok: true, data: { resolved: null, rect: dom.rectOf(also[0]!), candidates } }, painted: true };
      }
      ui.paint([], 'lost');
      // Painted: the user is looking at the lost screen right now.
      return { res: failed('ref_not_found'), painted: true };
    }

    if (cmd.autoScroll) dom.scrollTo(el);
    attachTracker(ui, el, also, step, 'shown', cmd);
    return { res: { ok: true, data: { resolved, rect: dom.rectOf(el) } }, painted: true };
  }

  function attachTracker(
    ui: Screen,
    el: Element,
    also: Element[],
    step: GuideStep,
    initial: 'shown' | 'ambiguous',
    cmd: HighlightCommand,
  ): void {
    const owner = cmd.presentationId;
    tracker?.detach();
    // Whether the user has fired *this* target since it was attached. The
    // activation listener below is the only writer, and every re-attach
    // starts a fresh target, so this can never carry a previous step's
    // answer forward.
    let used = false;
    trackedFor = owner;
    tracker = dom.track(el, also, {
      paint: (rects, status) => ui.paint(rects, initial === 'ambiguous' ? 'ambiguous' : status),
      onLost: (reason) => {
        // A target that vanished because the user just used it is not a
        // target we failed to find — it is a step that succeeded. On the DOM
        // the two are identical (the element is simply gone), which is why
        // pressing a link on github.com painted the "找不到这一步的目标"
        // screen ~50ms after the click and left it up for the whole second
        // the next plan took to arrive. The screen stays until the host
        // paints the next step or ends the run; its 结束引导 stays with it.
        if (used) return ui.paint([], 'settling');
        ui.paint([], 'lost');
        // Read from `current`, never from a captured step: one tracker used to
        // be built for the whole flow and reported step 0's ref forever.
        const ref = current?.step.ref ?? step.ref;
        if (current && ref) ports.emit({ type: 'TARGET_LOST', sessionId: current.sessionId, ref, reason });
      },
      isOccluded: (t) => ui.isOccluded(t),
    });
    target = el;

    // Watch the target being used — one of the four observation sources
    // (CONTEXT.md `Reading`), and the only thing that says the user did the
    // step: 「跳到目标」 hands over the keyboard and claims nothing, so whether
    // the step actually happened is answered by the page, never by a button
    // the user pressed for a different reason.
    //
    // A step to fill in is used once the user is done typing (`change`), not
    // at the first key: the model is woken by it, and woken mid-word it reads
    // a field still being filled.
    unwatchActivation?.();
    unwatchActivation = null;
    const use = (how: 'clicked' | 'typed') => () => {
      // Set before reporting, because the target can be torn out of the DOM
      // by the very handler this click is about to run.
      used = true;
      if (current) ports.emit({ type: 'STEP_USED', sessionId: current.sessionId, presentationId: owner, how });
    };
    if (CLICKED_ACTIONS.has(step.expectedUserAction)) unwatchActivation = dom.onActivate(el, use('clicked'));
    else if (step.expectedUserAction === 'input') unwatchActivation = dom.onCommit(el, use('typed'));

    if (initial === 'shown' && cmd.mode === 'guide') checkOnce(ui, el, cmd);
  }

  /** Clicking is using the target for these; `input` is used by typing into it. */
  const CLICKED_ACTIONS = new Set(['click', 'toggle', 'select']);

  /**
   * CONTEXT.md `Actionability`, once per presentation: a target that cannot be
   * operated right now — disabled, covered by something else, still moving —
   * is a fact the model can act on (fill the required field first, close what
   * is in the way). Judged over two frames and said once; the step stays
   * painted either way. A target that is not visible is not said here: that
   * is the tracker's `TARGET_LOST`, and one fact is one reading.
   */
  function checkOnce(ui: Screen, el: Element, cmd: HighlightCommand): void {
    const owner = cmd.presentationId;
    if (checkedFor === owner) return;
    stopCheck();
    checkedFor = owner;
    stopChecking = checkActionability(
      () => ({ probe: dom.probe(el), covered: ui.isOccluded(el) }),
      dom.nextFrame,
      (why) => {
        stopChecking = null;
        if (!why || why === 'hidden' || current?.presentationId !== owner) return;
        ports.emit({ type: 'STEP_NOT_ACTIONABLE', sessionId: current.sessionId, presentationId: owner, why });
      },
    );
  }

  /**
   * A step whose target is not on the page is reported at once, and looked
   * for again every time the page changes.
   *
   * At once, because a target that is not there is a fact about this page,
   * and what to do about it — wait for it, or point somewhere else — is the
   * model's (CONTEXT.md `Reading`). Said once per presentation: painting it
   * again tells nobody anything new.
   *
   * Looked for again because a menu the user was just told to open is the
   * very next thing that happens, and a guide that only reacted to its own
   * buttons looked frozen. One look per change, once the page's main thread
   * has nothing more urgent (`PresenterDom.whenIdle`): a change is usually
   * one of many, and binding in the middle of them reads a page still being
   * built.
   */
  let lostWatch: (() => void) | null = null;
  let watchingFor = '';
  let reportedMissing = '';
  let looks = 0;

  function stopWatching(): void {
    lostWatch?.();
    lostWatch = null;
  }

  function watchForTarget(cmd: HighlightCommand): void {
    const owner = cmd.presentationId;
    if (reportedMissing !== owner) {
      reportedMissing = owner;
      ports.emit({ type: 'TARGET_NOT_FOUND', sessionId: cmd.sessionId, presentationId: owner });
    }
    if (lostWatch && watchingFor === owner) return;
    stopWatching();
    watchingFor = owner;
    looks = 0;

    let cancelLook: (() => void) | null = null;
    const look = () => {
      cancelLook = null;
      looks += 1;
      if (current?.presentationId !== owner) return stopWatching();
      const { res } = render();
      // The page went somewhere else while looking. What it was looking for
      // belongs to the page left, so the watch ends here and says nothing; the
      // structure watcher reports the move.
      if (res.ok && res.data.failure === 'view_moved') return stopWatching();
      if (res.ok && !res.data.failure) {
        stopWatching();
        if (current && res.data.resolved)
          ports.emit({ type: 'TARGET_FOUND', sessionId: current.sessionId, ref: res.data.resolved });
      }
    };
    const unobserve = dom.onMutation(() => {
      if (!cancelLook) cancelLook = dom.whenIdle(look);
    });
    lostWatch = () => {
      unobserve();
      cancelLook?.();
      cancelLook = null;
    };
  }

  function view(cmd: HighlightCommand) {
    const d = cmd.step.descriptor;
    return {
      ...(cmd.progress ? { progress: cmd.progress } : {}),
      title: cmd.step.title,
      detail: cmd.step.detail,
      value: cmd.step.value,
      ...(cmd.mode === 'explain' ? { outline: true } : {}),
      looking: `找的是：${d.role}｜${d.name}${d.scope ? `（在「${d.scope}」内）` : ''}${d.nth !== undefined ? `（第 ${d.nth} 个）` : ''}`,
    };
  }

  /** After a render that painted: keep looking if what it painted is 「找不到」, stop if it found the target. */
  function followUp(cmd: HighlightCommand, res: ContentResponse<'HIGHLIGHT'>): void {
    if (res.ok && res.data.failure === 'ref_not_found') watchForTarget(cmd);
    else stopWatching();
  }

  async function show(mine: HighlightCommand): Promise<ContentResponse<'HIGHLIGHT'>> {
    // A refusal that painted nothing must leave no trace — adopting it would
    // keep a blocked step reachable through "重试定位". But a lost screen *is*
    // painted, and the command behind it must stay adopted or its buttons
    // report nothing.
    const previous = current;
    current = mine;
    const { res, painted } = render();
    if (!painted) {
      // A refusal leaves the previous presentation exactly as it was.
      current = previous;
      stopWatching();
      return res;
    }
    followUp(mine, res);
    return res;
  }

  return {
    get current() {
      return current;
    },
    get target() {
      return target;
    },
    get watch() {
      return { watching: lostWatch !== null, looks };
    },
    show,
    retry: () => {
      const cmd = current;
      if (!cmd) return;
      const { res, painted } = render();
      if (painted) followUp(cmd, res);
    },
    teardown,
  };
}
