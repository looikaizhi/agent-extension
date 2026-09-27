import type { OverlayMessage } from '@/shared/protocol';
import { readProse, type ProseInline, type ProseLine } from '@/shared/prose';
import type { Rect } from '@/shared/types';

const PAD = 4;
const NS = 'http://www.w3.org/2000/svg';

/**
 * Host properties the page must not be able to move. `display` is deliberately
 * absent: it is the one property that legitimately changes, so it is written
 * from whether a step or a message is up instead of from this table (see `apply`).
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
  /** The target is gone *because the user just used it* — the page is moving
   *  and the next step is being worked out. A distinct state from `lost`
   *  because the two are opposites: this one means the step succeeded. */
  | 'settling'
  | 'ambiguous';

export interface StepView {
  /** Which step of the run, and of how many; `total` is `null` when nobody
   *  knows (the model's steps), and the whole of it absent on an outline. */
  progress?: { index: number; total: number | null };
  title: string;
  detail?: string;
  /** For an `input` step: the text to type. Shown, never typed. */
  value?: string;
  /** What the step was looking for. Shown on the lost screen: "找不到目标" with
   *  no object is unactionable, and the person most likely to be reading it is
   *  the one who wrote the descriptor. */
  looking?: string;
  /** Extra holes with no pulse and no card anchor: what backs an answer, an ask's candidates. */
  alsoRects?: Rect[];
  /** Only outline: what backs an answer, or an ask's candidates. No step card —
   *  there is no step, and the words are on the message card. */
  outline?: boolean;
}

export interface OverlayCallbacks {
  onNext(): void;
  onExit(): void;
  onRetry(): void;
  /** The message card was closed with 关闭. */
  onCloseMessage(kind: OverlayMessage['kind']): void;
  /** The cross-site card was answered: `true` for 继续, `false` for 先不去. */
  onCrossSite(go: boolean): void;
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
  private message!: HTMLElement;
  /** What the message card says; `null` while it is down. */
  private said: OverlayMessage | null = null;
  /** The step on screen is only an outline: its card stays down. */
  private outlineOnly = false;
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
    this.message = this.root.querySelector('.message')!;

    // skip/exit appear in both the step row and the lost row — bind every match
    const bindAll = (sel: string, fn: () => void) =>
      this.root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    bindAll('.btn-next', () => this.cb.onNext());
    bindAll('.btn-exit', () => this.cb.onExit());
    bindAll('.btn-retry', () => this.cb.onRetry());
    bindAll('.btn-m-close', () => this.said && this.cb.onCloseMessage(this.said.kind));
    bindAll('.btn-m-go', () => this.cb.onCrossSite(true));
    bindAll('.btn-m-stay', () => this.cb.onCrossSite(false));

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
    // Up while a step is shown or a message is: either one is something the
    // user has to be able to read.
    const up = this.visible || this.said !== null;
    for (const [prop, value] of LOCK) this.host.style.setProperty(prop, value, 'important');
    this.host.style.setProperty('display', up ? 'block' : 'none', 'important');
    if (up !== this.host.matches(':popover-open')) {
      try {
        if (up) this.host.showPopover();
        else this.host.hidePopover();
      } catch {
        /* detached, or the UA already moved it for us */
      }
    }
  };

  setStep(step: StepView): void {
    this.outlineOnly = step.outline === true;
    const p = step.progress;
    this.root.querySelector('.step-n')!.textContent = !p ? '' : p.total === null ? `第 ${p.index + 1} 步` : `步骤 ${p.index + 1} / ${p.total}`;
    this.root.querySelector('.title')!.textContent = step.title;
    writeProse(this.root.querySelector('.detail')!, step.detail ?? '');
    // The suggested text sits next to the box, in a field the user copies from
    // by reading it. Nothing here writes into the page.
    const val = this.root.querySelector('.value') as HTMLElement;
    val.textContent = step.value ? `输入：${step.value}` : '';
    val.style.display = step.value ? '' : 'none';
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

  /** Multiple holes: an answer or an ask outlines several elements at once,
   *  and this is the reason a four-rect scrim was rejected — it cannot cut two holes. */
  paint(rects: Rect[], status: OverlayStatus): void {
    this.status = status;
    this.visible = true;
    this.apply();
    // `outline()` or `hide()` may have hidden these; an outline has no card.
    this.scrim.style.display = '';
    this.card.style.display = this.outlineOnly ? 'none' : '';

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
    // A message may keep the overlay up; nothing of the step is left on it.
    this.scrim.style.display = 'none';
    this.ring.style.display = 'none';
    this.card.style.display = 'none';
    this.apply();
    this.status = 'idle';
    this.lastRect = null;
  }

  /**
   * The card that says what is not a step (ticket 10c): a question, an answer,
   * a cross-site confirmation, or why the guide stopped. The side panel says
   * the same; this is for a user who is looking at the page, or has the panel
   * shut. Standing on its own: it stays up with or without a step, until the
   * user closes it or the host takes it down (`null`).
   */
  say(message: OverlayMessage | null): void {
    this.said = message;
    this.message.hidden = message === null;
    if (message) {
      this.message.querySelector('.m-title')!.textContent = message.title;
      writeProse(this.message.querySelector('.m-text')!, message.text);
      (this.message.querySelector('.m-close') as HTMLElement).hidden = message.kind === 'cross_site';
      (this.message.querySelector('.m-choose') as HTMLElement).hidden = message.kind !== 'cross_site';
    }
    this.apply();
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

  /**
   * The guide needs a model call and no open side panel can run it (ticket
   * 06c): one line on the card saying how to let it go on. Kept apart from the
   * status notice — it is about the guide, not about this step's target, and
   * stays through whatever the step shows until the host takes it down.
   */
  setWaiting(on: boolean): void {
    this.root.querySelector('.waiting')!.textContent = on ? WAITING_FOR_PANEL_TEXT : '';
  }

  /** Readback for the side panel and for E2E — a closed root has no other way in. */
  getState() {
    return {
      mounted: this.host.isConnected,
      visible: this.visible,
      rect: this.lastRect,
      status: this.status,
      waiting: this.root.querySelector('.waiting')!.textContent !== '',
      message: this.said
        ? {
            ...this.said,
            /** What the card shows for `text`, as markup — our own elements, read back. */
            rendered: this.message.querySelector('.m-text')!.innerHTML,
            buttons: [...this.message.querySelectorAll<HTMLElement>('button')]
              .filter((b) => b.offsetParent !== null)
              .map((b) => {
                const r = b.getBoundingClientRect();
                return { label: b.textContent ?? '', rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] as Rect };
              }),
          }
        : null,
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
  settling: '这一步完成了，正在看新页面…',
  ambiguous: '这一步的目标是下列几个之一，请按说明判断。',
};

/**
 * Fills `el` with what the model wrote, its few Markdown marks shown as what
 * they mean (`shared/prose.ts`). Built from elements and text nodes, never
 * from an HTML string: the words often quote the page this overlay sits on.
 */
function writeProse(el: Element, text: string): void {
  const doc = el.ownerDocument;
  const inline = (x: ProseInline): Node => {
    if (x.kind === 'text') return doc.createTextNode(x.text);
    const n = doc.createElement(x.kind);
    if (x.kind === 'code') n.textContent = x.text;
    else n.append(...x.parts.map(inline));
    return n;
  };
  const lines = (into: Element, ls: ProseLine[]): Element => {
    ls.forEach((line, i) => {
      if (i > 0) into.append(doc.createElement('br'));
      into.append(...line.map(inline));
    });
    return into;
  };
  el.replaceChildren(
    ...readProse(text).map((block) => {
      if (block.kind === 'para') return lines(doc.createElement('p'), block.lines);
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
      list.append(...block.items.map((item) => lines(doc.createElement('li'), item)));
      return list;
    }),
  );
}

const WAITING_FOR_PANEL_TEXT = '引导在等侧栏：模型要在侧栏里调用。点浏览器工具栏上的「页面引导」图标打开侧栏，引导就会接着走。';

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
  [hidden] { display: none !important; }
  .message {
    position: fixed; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px));
    pointer-events: auto; background: #10151f; color: #e8eefc;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14);
    box-shadow: 0 10px 34px rgba(0,0,0,.5);
  }
  .m-title { font-weight: 600; margin-bottom: 4px; }
  .m-text { font-size: 13px; white-space: pre-wrap; max-height: 40vh; overflow: auto; }
  :where(.m-text, .detail) :where(p, ul, ol) { margin: 0; }
  :where(.m-text, .detail) :where(ul, ol) { padding-left: 18px; }
  .m-text > * + *, .detail > * + * { margin-top: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em;
         padding: 0 3px; border-radius: 3px; background: rgba(255,255,255,.1); }
  .step-n { font-size: 11px; letter-spacing: .09em; opacity: .55; margin-bottom: 4px; }
  .step-n:empty { display: none; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .detail { font-size: 13px; opacity: .82; }
  .value { font-size: 13px; margin-top: 4px; padding: 3px 6px; border-radius: 4px;
           background: rgba(255,255,255,.12); font-family: ui-monospace, monospace; }
  .notice { font-size: 12px; color: #ffca6b; margin-top: 6px; }
  .notice:empty { display: none; }
  .waiting { font-size: 12px; color: #9fc3ff; margin-top: 6px; }
  .waiting:empty { display: none; }
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
  <div class="value"></div>
  <div class="notice"></div>
  <div class="waiting"></div>
  <div class="looking"></div>
  <div class="row step-actions">
    <button class="btn-next primary" title="把焦点移到目标上，之后按回车或空格即可触发——扩展不代你操作">跳到目标</button>
    <button class="btn-exit">结束</button>
  </div>
  <div class="row lost-actions" style="display:none">
    <button class="btn-retry primary">重试定位</button>
    <button class="btn-exit">结束引导</button>
  </div>
</div>
<div class="message" hidden>
  <div class="m-title"></div>
  <div class="m-text"></div>
  <div class="row m-close">
    <button class="btn-m-close">关闭</button>
  </div>
  <div class="row m-choose">
    <button class="btn-m-go primary">继续，带我去</button>
    <button class="btn-m-stay">先不去</button>
  </div>
</div>`;
