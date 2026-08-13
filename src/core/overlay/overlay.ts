import type { Rect } from '@/shared/types';

const PAD = 4;
const NS = 'http://www.w3.org/2000/svg';

/**
 * Host properties the page must not be able to move. `display` is deliberately
 * absent: it is the one property that legitimately changes, so it is written
 * from `Overlay.visible` instead of from this table (see `apply`).
 */
const LOCK: readonly (readonly [string, string])[] = [
  ['position', 'fixed'],
  ['inset', '0'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', 'none'],
  ['background', 'transparent'],
  ['pointer-events', 'none'],
  ['visibility', 'visible'],
  ['opacity', '1'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['contain', 'none'],
  ['overflow', 'visible'],
  ['z-index', '2147483647'],
];

export type OverlayStatus =
  | 'idle'
  | 'shown'
  | 'offscreen_up'
  | 'offscreen_down'
  | 'occluded'
  | 'lost'
  | 'ambiguous';

export interface StepView {
  index: number;
  total: number;
  title: string;
  detail?: string;
  /** What the step was looking for. Shown on the lost screen: "找不到目标" with
   *  no object is unactionable, and the person most likely to be reading it is
   *  the one who wrote the descriptor. */
  looking?: string;
  /** Extra holes with no pulse and no card anchor (explain / diagnose). */
  alsoRects?: Rect[];
}

export interface OverlayCallbacks {
  onNext(): void;
  onSkip(): void;
  onExit(): void;
  onRetry(): void;
}

/**
 * Closed shadow root + Top Layer.
 *
 * Four layers of protection, all load-bearing:
 *  1. closed root — page JS cannot reach `.shadowRoot` to read or tamper
 *  2. shadow boundary + `all: initial` — CSS cannot cross either way
 *  3. inline `!important` on the host — beats the page's own `!important`
 *     stylesheet rules, which the shadow boundary does NOT protect against
 *  4. Top Layer — beats z-index AND ancestor transform/filter/contain, which
 *     would otherwise capture a normal `position: fixed` element
 */
export class Overlay {
  private host: HTMLElement;
  private root: ShadowRoot;
  private scrim!: SVGRectElement;
  private mask!: SVGMaskElement;
  private svg!: SVGSVGElement;
  private ring!: HTMLElement;
  private card!: HTMLElement;
  private holes: SVGRectElement[] = [];
  private status: OverlayStatus = 'idle';
  private lastRect: Rect | null = null;
  private cb: OverlayCallbacks;
  /** The single source of truth for whether we are on screen. `apply()` restates
   *  it; nothing else is allowed to write `display` or touch the popover. */
  private visible = false;
  private guard: MutationObserver | null = null;

  constructor(cb: OverlayCallbacks) {
    this.cb = cb;
    this.host = document.createElement('div');
    this.host.setAttribute('data-page-guide', '');
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = TEMPLATE;
    document.documentElement.appendChild(this.host);

    this.svg = this.root.querySelector('svg')!;
    this.mask = this.root.querySelector('mask')!;
    this.scrim = this.root.querySelector('.scrim')!;
    this.ring = this.root.querySelector('.ring')!;
    this.card = this.root.querySelector('.card')!;

    // skip/exit appear in both the step row and the lost row — bind every match
    const bindAll = (sel: string, fn: () => void) =>
      this.root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    bindAll('.btn-next', () => this.cb.onNext());
    bindAll('.btn-skip', () => this.cb.onSkip());
    bindAll('.btn-exit', () => this.cb.onExit());
    bindAll('.btn-retry', () => this.cb.onRetry());

    this.harden();
  }

  /** Page CSS can hit the host element itself; inline !important wins the cascade. */
  private harden(): void {
    this.host.setAttribute('popover', 'manual');
    this.apply();
    // Two targets, one observer. Attribute records land on the host, but the
    // *removal* of the host is recorded on its parent — watching only the host
    // is why layer 3 was dead code (F-3).
    this.guard = new MutationObserver(this.reassert);
    this.guard.observe(this.host, { attributes: true, attributeFilter: ['style', 'class', 'popover'] });
    this.guard.observe(document.documentElement, { childList: true });
  }

  private reassert = (): void => {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.apply();
  };

  /**
   * Restates the *desired* state — never a constant.
   *
   * This is the whole of the F-2 fix: `apply()` used to assert `display: block`
   * unconditionally, so `hide()` writing `display: none` woke the observer,
   * which wrote `block` straight back. Hardening ate hiding, and the scrim
   * became unremovable. Deriving both writes from `this.visible` means the two
   * cannot disagree, whoever fires first.
   */
  private apply = (): void => {
    for (const [prop, value] of LOCK) this.host.style.setProperty(prop, value, 'important');
    this.host.style.setProperty('display', this.visible ? 'block' : 'none', 'important');
    if (this.visible !== this.host.matches(':popover-open')) {
      try {
        if (this.visible) this.host.showPopover();
        else this.host.hidePopover();
      } catch {
        /* detached, or the UA already moved it for us */
      }
    }
  };

  setStep(step: StepView): void {
    this.root.querySelector('.step-n')!.textContent = `步骤 ${step.index + 1} / ${step.total}`;
    this.root.querySelector('.title')!.textContent = step.title;
    this.root.querySelector('.detail')!.textContent = step.detail ?? '';
    this.root.querySelector('.looking')!.textContent = step.looking ?? '';
  }

  /**
   * Authoring mode: a bare outline, no scrim and no card.
   *
   * Hover feedback must not dim the page — the author is reading it to decide
   * what to point at, and a 55% scrim over everything they are trying to judge
   * would defeat the purpose.
   */
  outline(rect: Rect | null): void {
    this.visible = rect !== null;
    this.apply();
    this.scrim.style.display = 'none';
    this.card.style.display = 'none';
    if (!rect) return;
    this.status = 'shown';
    this.lastRect = rect;
    this.ring.style.display = 'block';
    this.ring.style.left = `${rect[0] - PAD}px`;
    this.ring.style.top = `${rect[1] - PAD}px`;
    this.ring.style.width = `${rect[2] + PAD * 2}px`;
    this.ring.style.height = `${rect[3] + PAD * 2}px`;
  }

  /** Multiple holes: `explain` / `diagnose` return a `refs` array, and this is
   *  the reason a four-rect scrim was rejected — it cannot cut two holes. */
  paint(rects: Rect[], status: OverlayStatus): void {
    this.status = status;
    this.visible = true;
    this.apply();
    // `outline()` may have hidden these.
    this.scrim.style.display = '';
    this.card.style.display = '';

    const w = window.innerWidth;
    const h = window.innerHeight;
    this.svg.setAttribute('width', String(w));
    this.svg.setAttribute('height', String(h));
    this.scrim.setAttribute('width', String(w));
    this.scrim.setAttribute('height', String(h));
    this.root.querySelector('.mask-bg')!.setAttribute('width', String(w));
    this.root.querySelector('.mask-bg')!.setAttribute('height', String(h));

    while (this.holes.length < rects.length) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('rx', '6');
      r.setAttribute('fill', 'black');
      this.mask.appendChild(r);
      this.holes.push(r);
    }
    for (const [i, hole] of this.holes.entries()) {
      const rect = rects[i];
      if (!rect) {
        hole.setAttribute('width', '0');
        hole.setAttribute('height', '0');
        continue;
      }
      hole.setAttribute('x', String(rect[0] - PAD));
      hole.setAttribute('y', String(rect[1] - PAD));
      hole.setAttribute('width', String(rect[2] + PAD * 2));
      hole.setAttribute('height', String(rect[3] + PAD * 2));
    }

    const primary = rects[0] ?? null;
    this.lastRect = primary;
    if (primary && (status === 'shown' || status === 'occluded' || status === 'ambiguous')) {
      this.ring.style.display = 'block';
      this.ring.style.left = `${primary[0] - PAD}px`;
      this.ring.style.top = `${primary[1] - PAD}px`;
      this.ring.style.width = `${primary[2] + PAD * 2}px`;
      this.ring.style.height = `${primary[3] + PAD * 2}px`;
    } else {
      this.ring.style.display = 'none';
    }

    this.host.dataset.status = status;
    this.root.querySelector('.notice')!.textContent = NOTICE[status] ?? '';
    (this.root.querySelector('.lost-actions') as HTMLElement).style.display =
      status === 'lost' ? 'flex' : 'none';
    (this.root.querySelector('.step-actions') as HTMLElement).style.display =
      status === 'lost' ? 'none' : 'flex';

    this.placeCard(primary);
  }

  private placeCard(rect: Rect | null): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(340, vw - 16);
    this.card.style.width = `${cw}px`;
    const ch = this.card.offsetHeight || 130;

    if (!rect) {
      this.card.style.left = `${Math.round((vw - cw) / 2)}px`;
      this.card.style.top = `${Math.round(vh / 2 - ch / 2)}px`;
      return;
    }
    const below = rect[1] + rect[3] + 12 + ch < vh;
    const top = below ? rect[1] + rect[3] + 12 : Math.max(8, rect[1] - ch - 12);
    const left = Math.min(Math.max(8, rect[0]), vw - cw - 8);
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${Math.round(top)}px`;
  }

  hide(): void {
    this.visible = false;
    this.apply();
    this.status = 'idle';
    this.lastRect = null;
  }

  destroy(): void {
    // Must come first: the guard would otherwise resurrect the host we are
    // about to remove.
    this.guard?.disconnect();
    this.guard = null;
    this.visible = false;
    try {
      this.host.hidePopover();
    } catch {
      /* not open */
    }
    this.host.remove();
  }

  /** Readback for the side panel and for E2E — a closed root has no other way in. */
  getState() {
    return {
      mounted: this.host.isConnected,
      visible: this.visible,
      rect: this.lastRect,
      status: this.status,
    };
  }

  /** Does anything paint above us at the target's centre? */
  isOccluded(target: Element): boolean {
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    if (!top) return false;
    return top !== target && !target.contains(top) && !top.contains(target);
  }
}

const NOTICE: Partial<Record<OverlayStatus, string>> = {
  offscreen_up: '目标在上方 ↑',
  offscreen_down: '目标在下方 ↓',
  occluded: '目标被其他内容遮挡',
  lost: '找不到这一步的目标，页面可能已经变化。',
  ambiguous: '这一步的目标是下列几个之一，请按说明判断。',
};

const TEMPLATE = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  svg { position: fixed; inset: 0; pointer-events: none; }
  .ring {
    position: fixed; border: 3px solid #4f9cff; border-radius: 6px; pointer-events: none;
    box-shadow: 0 0 0 3px rgba(79,156,255,.30), 0 0 20px 4px rgba(79,156,255,.45);
    transition: left .18s cubic-bezier(.4,0,.2,1), top .18s cubic-bezier(.4,0,.2,1),
                width .18s cubic-bezier(.4,0,.2,1), height .18s cubic-bezier(.4,0,.2,1);
  }
  .ring::after {
    content: ''; position: absolute; inset: -3px; border: 3px solid #4f9cff;
    border-radius: 6px; animation: pulse 1.6s ease-out infinite;
  }
  @keyframes pulse { 0% { transform: scale(1); opacity: .85 } 100% { transform: scale(1.16); opacity: 0 } }
  @media (prefers-reduced-motion: reduce) {
    .ring::after { animation: none; }
    .ring { transition: none; }
  }
  .card {
    position: fixed; pointer-events: auto; background: #10151f; color: #e8eefc;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 10px 34px rgba(0,0,0,.5);
  }
  .step-n { font-size: 11px; letter-spacing: .09em; opacity: .55; margin-bottom: 4px; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .detail { font-size: 13px; opacity: .82; }
  .notice { font-size: 12px; color: #ffca6b; margin-top: 6px; }
  .notice:empty { display: none; }
  .looking { font-size: 11.5px; opacity: .6; margin-top: 4px; font-family: ui-monospace, monospace; }
  .looking:empty { display: none; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  button {
    font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: inherit;
  }
  button:hover { background: rgba(255,255,255,.13); }
  button.primary { background: #2f6fd0; border-color: #2f6fd0; }
  button.primary:hover { background: #3b81ea; }
</style>
<svg aria-hidden="true">
  <defs>
    <mask id="pg-hole" maskUnits="userSpaceOnUse">
      <rect class="mask-bg" x="0" y="0" fill="white"></rect>
    </mask>
  </defs>
  <rect class="scrim" x="0" y="0" fill="rgba(6,10,18,.55)" mask="url(#pg-hole)"></rect>
</svg>
<div class="ring"></div>
<div class="card">
  <div class="step-n"></div>
  <div class="title"></div>
  <div class="detail"></div>
  <div class="notice"></div>
  <div class="looking"></div>
  <div class="row step-actions">
    <button class="btn-next primary">下一步</button>
    <button class="btn-skip">跳过</button>
    <button class="btn-exit">结束</button>
  </div>
  <div class="row lost-actions" style="display:none">
    <button class="btn-retry primary">重试定位</button>
    <button class="btn-skip">跳过此步</button>
    <button class="btn-exit">结束引导</button>
  </div>
</div>`;
