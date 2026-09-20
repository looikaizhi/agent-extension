import type { Rect } from '@/shared/types';
import type { OverlayStatus } from './overlay';

const IDLE_FRAMES = 20; // ≈330 ms of stillness before we stop scheduling
const LOST_FRAMES = 3; // survives React's remove-then-reinsert in the same tick
const MIN_DELTA = 0.5; // ignore sub-pixel jitter

export interface TrackerSink {
  paint(rects: Rect[], status: OverlayStatus): void;
  onLost(reason: 'removed' | 'hidden' | 'zero_area'): void;
  isOccluded(el: Element): boolean;
}

/**
 * Four rules keep this cheap on heavy consoles:
 *  1. exactly one rAF loop, and it falls asleep when nothing moves
 *  2. observers only set a dirty bit — MutationObserver can fire hundreds of
 *     times per second on a console page, so its callback must do nothing
 *  3. strict read-then-write, or every frame forces a layout flush
 *  4. only write when something moved by more than half a pixel
 */
export class TargetTracker {
  private el: Element | null = null;
  private also: Element[] = [];
  private dirty = true;
  private rafId = 0;
  private stable = 0;
  private lostFrames = 0;
  private last: Rect | null = null;
  private disposers: Array<() => void> = [];
  private sink: TrackerSink;

  constructor(sink: TrackerSink) {
    this.sink = sink;
  }

  attach(el: Element, also: Element[] = []): void {
    this.detach();
    this.el = el;
    this.also = also;
    this.lostFrames = 0;
    this.last = null;

    const wake = this.wake;
    const ro = new ResizeObserver(wake);
    ro.observe(el);
    ro.observe(document.documentElement);

    const io = new IntersectionObserver(wake, { threshold: [0, 0.01, 1] });
    io.observe(el);

    const mo = new MutationObserver(wake);
    mo.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-expanded'],
    });

    // scroll does not bubble, but it does capture — one listener covers every
    // scrollable container on the page, nested ones included.
    addEventListener('scroll', wake, { capture: true, passive: true });
    addEventListener('resize', wake, { passive: true });
    visualViewport?.addEventListener('resize', wake);
    visualViewport?.addEventListener('scroll', wake);
    document.addEventListener('transitionend', wake, true);
    document.addEventListener('animationend', wake, true);

    this.disposers = [
      () => ro.disconnect(),
      () => io.disconnect(),
      () => mo.disconnect(),
      () => removeEventListener('scroll', wake, { capture: true } as EventListenerOptions),
      () => removeEventListener('resize', wake),
      () => visualViewport?.removeEventListener('resize', wake),
      () => visualViewport?.removeEventListener('scroll', wake),
      () => document.removeEventListener('transitionend', wake, true),
      () => document.removeEventListener('animationend', wake, true),
    ];

    this.wake();
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.el = null;
    this.also = [];
  }

  private wake = (): void => {
    this.dirty = true;
    this.stable = 0;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.tick);
  };

  private tick = (): void => {
    this.rafId = 0;
    const el = this.el;
    if (!el) return;
    const wasDirty = this.dirty;
    this.dirty = false;

    // ---- read phase ----
    const connected = el.isConnected;
    const visible =
      connected &&
      el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      });
    const r = visible ? el.getBoundingClientRect() : null;
    const zeroArea = r !== null && (r.width < 1 || r.height < 1);
    const rect: Rect | null =
      r && !zeroArea ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null;
    const alsoRects: Rect[] = [];
    for (const a of this.also) {
      if (!a.isConnected) continue;
      const ar = a.getBoundingClientRect();
      if (ar.width >= 1 && ar.height >= 1)
        alsoRects.push([Math.round(ar.x), Math.round(ar.y), Math.round(ar.width), Math.round(ar.height)]);
    }

    if (!rect) {
      this.lostFrames += 1;
      if (this.lostFrames >= LOST_FRAMES) {
        this.sink.onLost(!connected ? 'removed' : zeroArea ? 'zero_area' : 'hidden');
        this.detach();
        return;
      }
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    this.lostFrames = 0;

    // Three distinct states, because the product response differs. Reporting
    // "scrolled out of view" as "not found" is a product bug: the user thinks
    // the guide broke.
    let status: OverlayStatus = 'shown';
    if (rect[1] + rect[3] < 0) status = 'offscreen_up';
    else if (rect[1] > window.innerHeight) status = 'offscreen_down';
    else if (this.sink.isOccluded(el)) status = 'occluded';

    // ---- write phase ----
    if (wasDirty || moved(rect, this.last)) {
      this.sink.paint([rect, ...alsoRects], status);
      this.last = rect;
      this.stable = 0;
    } else {
      this.stable += 1;
    }

    if (this.stable < IDLE_FRAMES) this.rafId = requestAnimationFrame(this.tick);
    // else: sleep until an observer wakes us
  };
}

function moved(a: Rect, b: Rect | null): boolean {
  if (!b) return true;
  return (
    Math.abs(a[0] - b[0]) > MIN_DELTA ||
    Math.abs(a[1] - b[1]) > MIN_DELTA ||
    Math.abs(a[2] - b[2]) > MIN_DELTA ||
    Math.abs(a[3] - b[3]) > MIN_DELTA
  );
}
