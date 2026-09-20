import { registry } from '@/core/extractor/registry';
import type { Rect, Ref } from '@/shared/types';
import { TargetTracker, type TrackerSink } from './tracker';

/**
 * The live page, as the presenter uses it: every primitive it needs and none
 * of the decisions about when to use them.
 *
 * Kept apart so the decisions — when to look again, whether a target can be
 * operated, what a replaced presentation may still do — run in a plain node
 * test that turns the page's frames and idle moments itself, while this file
 * is proven where a real page exists (e2e).
 */
export interface PresenterDom {
  /** The address the tab is at right now. */
  view(): string;
  /** The live element a ref names in a snapshot; `null` when the snapshot is stale, the ref unknown or the node gone. */
  resolve(snapshotId: string, ref: Ref): Element | null;
  /** Brings `el` to the middle of the viewport, at once. Not smoothly: a
   *  scroll still under way is the page moving, and the target would be judged
   *  not actionable for motion we caused ourselves. */
  scrollTo(el: Element): void;
  rectOf(el: Element): Rect;
  /** What an actionability check reads off `el` in one frame (`actionability.ts`). */
  probe(el: Element): Probe;
  /** Starts following an element on screen; the handle stops it. */
  track(el: Element, also: Element[], sink: TrackerSink): { detach(): void };
  /** Calls `fn` once, the moment the user activates `el`; the returned function stops listening. */
  onActivate(el: Element, fn: () => void): () => void;
  /** Calls `fn` once, when the user has changed the value of `el` and is done
   *  with it (`change`); the returned function stops listening. */
  onCommit(el: Element, fn: () => void): () => void;
  /** Calls `fn` on the page changes that can make a missing target appear; the returned function stops listening. */
  onMutation(fn: () => void): () => void;
  /** Calls `fn` once, as soon as the page's main thread has nothing more
   *  urgent to do; the returned function calls it off. */
  whenIdle(fn: () => void): () => void;
  /** Calls `fn` once, on the next animation frame; the returned function calls it off. */
  nextFrame(fn: () => void): () => void;
}

/** One frame's reading of a target, for `actionability.ts` to judge. */
export interface Probe {
  /** Rendered, with an area: what `TargetTracker` also counts as on the page. */
  visible: boolean;
  /** Not `:disabled`, and not marked `aria-disabled`. */
  enabled: boolean;
  rect: Rect;
}

/** `scheduler.postTask` — in Chrome since 94, below the manifest's minimum;
 *  not yet in TypeScript's DOM library. */
declare const scheduler: {
  postTask(callback: () => void, options: { priority: 'background'; signal: AbortSignal }): Promise<void>;
};

export const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
};

export const presenterDom: PresenterDom = {
  view: () => location.href,
  resolve: (snapshotId, ref) => registry.resolve(snapshotId, ref),
  // `block: 'center'` also sidesteps sticky headers; nested scroll containers
  // and shadow DOM are handled by the platform.
  scrollTo: (el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
  rectOf,
  probe(el) {
    const rect = rectOf(el);
    const visible =
      el.isConnected &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) &&
      rect[2] >= 1 &&
      rect[3] >= 1;
    const enabled = !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
    return { visible, enabled, rect };
  },
  track(el, also, sink) {
    const tracker = new TargetTracker(sink);
    tracker.attach(el, also);
    return tracker;
  },
  // Listening is not acting. The listener is passive and never cancels.
  onActivate(el, fn) {
    el.addEventListener('click', fn, { capture: true, once: true, passive: true });
    return () => el.removeEventListener('click', fn, { capture: true });
  },
  onCommit(el, fn) {
    el.addEventListener('change', fn, { capture: true, once: true, passive: true });
    return () => el.removeEventListener('change', fn, { capture: true });
  },
  onMutation(fn) {
    const mo = new MutationObserver(fn);
    mo.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'hidden', 'aria-hidden', 'class', 'style'],
    });
    return () => mo.disconnect();
  },
  // The lowest-priority task, not an idle callback. An idle callback waits for
  // an idle period, and a page may never have one: every frame's budget spent
  // by the page itself, or — seen on a still page — no frame drawn to end one.
  // A missing target that came back then sat unlooked-for until something
  // else moved. A task at background priority runs once the page has nothing
  // more urgent, idle period or not.
  whenIdle(fn) {
    const off = new AbortController();
    // Called off rejects with the abort; anything `fn` throws still surfaces.
    scheduler.postTask(fn, { priority: 'background', signal: off.signal }).catch((e: unknown) => {
      if (!off.signal.aborted) throw e;
    });
    return () => off.abort();
  },
  nextFrame(fn) {
    const id = requestAnimationFrame(() => fn());
    return () => cancelAnimationFrame(id);
  },
};
