import { applyAppearance, type Appearance } from '@/shared/appearance';
import { progressCells, stepLabels } from '@/shared/progress';
import type { OverlayMessage } from '@/shared/protocol';
import { readProse, type ProseInline, type ProseLine } from '@/shared/prose';
import tokens from '@/shared/theme/tokens.css?inline';
import type { Rect } from '@/shared/types';
import { bounds, PAD, placeCard, placePeek, veilPath } from './geometry';

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

/** A control, the way the overlay names it: its role and its accessible name. */
export interface Named {
  role: string;
  name: string;
}

export interface StepView {
  /** Which step of the run, and of how many; `total` is `null` when nobody
   *  knows (the model's steps), and the whole of it absent on an outline. */
  progress?: { index: number; total: number | null };
  title: string;
  detail?: string;
  /** For an `input` step: the text to type. Shown, never typed. */
  value?: string;
  /** What the step points at, for 夜航's label over the target. */
  target?: Named;
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
  private veil!: HTMLElement;
  private ringLayer!: HTMLElement;
  /** One per rectangle painted; the first is the target's, the rest are
   *  candidates or what backs an answer. */
  private rings: HTMLElement[] = [];
  private card!: HTMLElement;
  private pointer!: HTMLElement;
  private peek!: HTMLElement;
  private message!: HTMLElement;
  private waiting!: HTMLElement;
  /** Carries `data-style` / `data-shade`, which every colour below is keyed on. */
  private themed!: HTMLElement;
  /** Stops following the system's light/dark, for 跟随系统. */
  private unfollow: () => void = () => {};
  /** What the message card says; `null` while it is down. */
  private said: OverlayMessage | null = null;
  /** The step on screen is only an outline: its card stays down. */
  private outlineOnly = false;
  /** What the step points at, for the label over its ring. */
  private target: Named | null = null;
  private status: OverlayStatus = 'idle';
  private lastRect: Rect | null = null;
  private cb: OverlayCallbacks;
  /** The single source of truth for whether we are on screen. `apply()` restates
   *  it; nothing else is allowed to write `display` or touch the popover. */
  private visible = false;
  private guard: MutationObserver | null = null;

  constructor(cb: OverlayCallbacks, appearance: Appearance) {
    this.cb = cb;
    this.host = document.createElement('div');
    this.host.setAttribute('data-page-guide', '');
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = TEMPLATE;
    document.documentElement.appendChild(this.host);

    this.veil = this.root.querySelector('.veil')!;
    this.ringLayer = this.root.querySelector('.rings')!;
    this.card = this.root.querySelector('.card')!;
    this.pointer = this.root.querySelector('.pointer')!;
    this.peek = this.root.querySelector('.peek')!;
    this.message = this.root.querySelector('.message')!;
    this.waiting = this.root.querySelector('.waiting')!;
    this.themed = this.root.querySelector('.theme')!;
    this.setAppearance(appearance);

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

  /** The look to paint in (CONTEXT.md `Appearance`). Only the two attributes the
   *  tokens key on change; nothing on screen is rebuilt. */
  setAppearance(a: Appearance): void {
    this.unfollow();
    this.unfollow = applyAppearance(this.themed, a);
  }

  setStep(step: StepView): void {
    this.outlineOnly = step.outline === true;
    this.target = step.target ?? null;
    const p = step.progress;
    const label = p ? stepLabels(p.index, p.total) : null;
    this.root.querySelector('.head')!.toggleAttribute('hidden', !label);
    this.root.querySelector('.step-n .for-hud')!.textContent = label?.hud ?? '';
    this.root.querySelector('.step-n .for-depth')!.textContent = label?.depth ?? '';
    const cells = p ? progressCells(p.index, p.total) : [];
    this.root.querySelector('.bar')!.replaceChildren(...cells.map((c) => cell(c)));
    // 景深 draws only what has been walked: a dot per step done, a pill for this one.
    this.root.querySelector('.pips')!.replaceChildren(...cells.filter((c) => c === 'done' || c === 'cur').map((c) => cell(c)));
    this.root.querySelector('.title')!.textContent = step.title;
    writeProse(this.root.querySelector('.detail')!, step.detail ?? '');
    // The suggested text sits next to the box, in a field the user copies from
    // by reading it. Nothing here writes into the page.
    this.root.querySelector('.value')!.toggleAttribute('hidden', !step.value);
    this.root.querySelector('.v-text')!.textContent = step.value ?? '';
    this.root.querySelector('.looking')!.textContent = step.looking ?? '';
  }

  /**
   * Authoring mode: a bare outline, no veil and no card — and, over it, which
   * control this is, so the author knows what a click would pick.
   *
   * Hover feedback must not dim the page — the author is reading it to decide
   * what to point at, and a veil over everything they are trying to judge
   * would defeat the purpose.
   */
  outline(rect: Rect | null, named?: Named): void {
    this.visible = rect !== null;
    this.apply();
    this.veil.style.display = 'none';
    this.card.style.display = 'none';
    this.peek.style.display = 'none';
    if (!rect) return;
    this.status = 'shown';
    this.lastRect = rect;
    this.placeRings([rect], 'bare');
    if (!named) return;
    this.peek.querySelector('.p-role')!.textContent = named.role;
    this.peek.querySelector('.p-name')!.textContent = named.name || '（无名称）';
    this.peek.style.display = '';
    const at = placePeek(rect, window.innerWidth, window.innerHeight, this.peek.offsetWidth, this.peek.offsetHeight);
    this.peek.style.left = `${at.left}px`;
    this.peek.style.top = `${at.top}px`;
  }

  /** Multiple holes: an answer or an ask outlines several elements at once,
   *  and this is the reason a four-rect scrim was rejected — it cannot cut two holes. */
  paint(rects: Rect[], status: OverlayStatus): void {
    this.status = status;
    this.visible = true;
    this.apply();
    // `outline()` or `hide()` may have hidden these; an outline has no card.
    this.veil.style.display = '';
    this.peek.style.display = 'none';
    this.card.style.display = this.outlineOnly ? 'none' : '';
    this.veil.style.clipPath = `path(evenodd, '${veilPath(window.innerWidth, window.innerHeight, rects)}')`;

    const primary = rects[0] ?? null;
    this.lastRect = primary;
    const ringed = status === 'shown' || status === 'occluded' || status === 'ambiguous';
    // One target, on a guide step: 夜航 frames it and names it. Candidates and
    // what backs an answer are only circled.
    this.placeRings(ringed ? rects : [], rects.length === 1 && !this.outlineOnly && status !== 'ambiguous' ? 'framed' : 'lead');

    this.host.dataset.status = status;
    this.root.querySelector('.n-text')!.textContent = NOTICE[status] ?? '';
    this.root.querySelector('.n-icon')!.innerHTML = NOTICE_ICON[status] ?? '';
    (this.root.querySelector('.btn-next') as HTMLButtonElement).disabled = status === 'settling';
    (this.root.querySelector('.lost-actions') as HTMLElement).hidden = status !== 'lost';
    (this.root.querySelector('.step-actions') as HTMLElement).hidden = status === 'lost';

    // Several candidates: the card sits beside all of them, covering none, and
    // points at no one of them.
    this.placeCard(rects.length > 1 ? bounds(rects) : primary, rects.length === 1);
  }

  /**
   * One ring per rectangle, reused across paints so the target's ring glides
   * rather than blinks. `framed` is the lone target of a step (夜航's corner
   * marks and label); `lead` pulses the first of several; `bare` is the
   * inspector's hover.
   */
  private placeRings(rects: readonly Rect[], mode: 'framed' | 'lead' | 'bare'): void {
    while (this.rings.length < rects.length) {
      const ring = document.createElement('div');
      ring.className = 'ring';
      ring.innerHTML = RING_INSIDE;
      this.ringLayer.appendChild(ring);
      this.rings.push(ring);
    }
    this.rings.forEach((ring, i) => {
      const r = rects[i];
      ring.style.display = r ? 'block' : 'none';
      if (!r) return;
      ring.style.left = `${r[0] - PAD}px`;
      ring.style.top = `${r[1] - PAD}px`;
      ring.style.width = `${r[2] + PAD * 2}px`;
      ring.style.height = `${r[3] + PAD * 2}px`;
      ring.className = i === 0 ? `ring ${mode}` : 'ring';
    });
    const tag = this.rings[0]?.querySelector('.tag');
    if (tag) tag.textContent = this.target ? `TARGET · ${this.target.role}「${this.target.name}」` : '';
  }

  private placeCard(rect: Rect | null, pointing: boolean): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(340, vw - 16);
    this.card.style.width = `${cw}px`;
    const at = placeCard(rect, vw, vh, cw, this.card.offsetHeight || 130);
    this.card.style.left = `${at.left}px`;
    this.card.style.top = `${at.top}px`;
    this.card.dataset.side = at.side;
    this.pointer.hidden = !pointing || at.pointerX === null;
    if (at.pointerX !== null) this.pointer.style.left = `${at.pointerX - 7}px`;
    // 夜航's label sits over the target; a card above it, or the top of the
    // viewport, leaves it no room.
    const tag = this.rings[0]?.querySelector<HTMLElement>('.tag');
    if (!tag) return;
    tag.hidden = rect === null || at.side === 'above' || rect[1] - PAD <= 44;
    // Flush with the ring's right edge, unless that runs it off the left of the viewport.
    tag.classList.toggle('start', rect !== null && rect[0] + rect[2] + PAD + 8 - tag.offsetWidth < 8);
  }

  hide(): void {
    this.visible = false;
    // A message may keep the overlay up; nothing of the step is left on it.
    this.veil.style.display = 'none';
    this.placeRings([], 'bare');
    this.card.style.display = 'none';
    this.peek.style.display = 'none';
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
      this.message.dataset.kind = message.kind;
      this.message.querySelector('.m-icon')!.innerHTML = MESSAGE_ICON[message.kind];
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
    this.unfollow();
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
    this.waiting.hidden = !on;
  }

  /** Readback for the side panel and for E2E — a closed root has no other way in. */
  getState() {
    return {
      mounted: this.host.isConnected,
      visible: this.visible,
      rect: this.lastRect,
      status: this.status,
      waiting: !this.waiting.hidden,
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

/** A cell of the progress track (`shared/progress.ts`). */
function cell(kind: string): HTMLElement {
  const el = document.createElement('span');
  el.className = kind;
  return el;
}

const NOTICE: Partial<Record<OverlayStatus, string>> = {
  offscreen_up: '目标在上方，往上滚就能看到',
  offscreen_down: '目标在下方，往下滚就能看到',
  occluded: '目标被其他内容遮挡',
  lost: '找不到这一步的目标，页面可能已经变化。',
  settling: '这一步完成了，正在看新页面…',
  ambiguous: '这一步的目标是下列几个之一，请按说明判断。',
};

/*
 * Icons are our own constant markup, the only strings this file ever gives to
 * `innerHTML` — nothing that came from the page or the model goes there.
 */
const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ALERT = svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.5v.01"/>');
const WARN = svg('<path d="M12 4L2.5 20h19L12 4z"/><path d="M12 10v4.5M12 17.5v.01"/>');
const INFO = svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>');

const NOTICE_ICON: Partial<Record<OverlayStatus, string>> = {
  offscreen_up: svg('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  offscreen_down: svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
  occluded: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  lost: ALERT,
  // `settling` shows a spinner instead (CSS).
  ambiguous: WARN,
};

const MESSAGE_ICON: Record<OverlayMessage['kind'], string> = {
  ask: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4M12 16.8v.01"/>'),
  answer: svg('<path d="M4 5h16v11H9l-5 4V5z"/>'),
  cross_site: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>'),
  note: INFO,
};

/** 夜航's four corner marks, and its label over the target. */
const RING_INSIDE = '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><span class="tag"></span>';

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

/*
 * Every colour, radius and typeface comes from the theme tokens (shared with the
 * side panel), keyed on `.theme`'s `data-style` / `data-shade` — switching the
 * look is `setAppearance`, never a second stylesheet. What differs between the
 * two looks in shape rather than colour is written under `[data-style]`. System
 * fonts only: an @font-face declared inside a shadow root does not apply, and
 * the page's CSP may block a font from anywhere else.
 */
const TEMPLATE = `
<style>${tokens}</style>
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .theme { display: contents; }
  [data-style='hud'] .for-depth, [data-style='depth'] .for-hud { display: none !important; }

  /* The veil: everything but the target, dimmed — and in 景深, blurred. */
  .veil {
    position: fixed; inset: 0; pointer-events: none;
    background: var(--veil);
    -webkit-backdrop-filter: var(--v-blur); backdrop-filter: var(--v-blur);
  }

  .ring {
    position: fixed; pointer-events: none; border-radius: 9px;
    border: 1.5px solid var(--ring); box-shadow: 0 0 0 4px var(--ring-halo);
    transition: left .18s cubic-bezier(.4,0,.2,1), top .18s cubic-bezier(.4,0,.2,1),
                width .18s cubic-bezier(.4,0,.2,1), height .18s cubic-bezier(.4,0,.2,1);
  }
  [data-style='depth'] .ring {
    border: none; border-radius: 10px;
    box-shadow: 0 0 0 2px var(--ring), 0 0 0 7px var(--ring-halo), 0 14px 34px var(--ring-halo);
  }
  .ring:is(.framed, .lead)::after {
    content: ''; position: absolute; inset: -2px; border: 2px solid var(--ring);
    border-radius: inherit; animation: pulse 1.6s ease-out infinite;
  }
  @keyframes pulse { 0% { transform: scale(1); opacity: .85 } 100% { transform: scale(1.16); opacity: 0 } }
  /* 夜航: a viewfinder's four corners, and the target named over it. */
  .c { display: none; position: absolute; width: 14px; height: 14px; border: 0 solid var(--ring); }
  .tl { left: -8px; top: -8px; border-width: 2px 0 0 2px; }
  .tr { right: -8px; top: -8px; border-width: 2px 2px 0 0; }
  .bl { left: -8px; bottom: -8px; border-width: 0 0 2px 2px; }
  .br { right: -8px; bottom: -8px; border-width: 0 2px 2px 0; }
  [data-style='hud'] .ring.framed .c { display: block; }
  /* Laid out in both looks so its width can be measured whichever is on;
     only 夜航 shows it. */
  .tag {
    position: absolute; right: -8px; bottom: calc(100% + 14px); width: max-content; max-width: 320px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 3px 7px; border-radius: 4px; background: var(--tag-bg); color: var(--tag-fg);
    font: 600 10.5px/1.4 var(--font-mono); letter-spacing: .04em;
    visibility: hidden;
  }
  .tag.start { right: auto; left: -8px; }
  .tag:empty { display: none; }
  [data-style='hud'] .ring.framed .tag { visibility: visible; }

  .card, .message, .peek {
    position: fixed; pointer-events: auto;
    background: var(--o-bg); color: var(--o-fg);
    font: 14px/1.55 var(--font);
    border: 1px solid var(--o-b); border-radius: var(--r-card-o);
    box-shadow: var(--o-sh);
    -webkit-backdrop-filter: var(--o-blur); backdrop-filter: var(--o-blur);
  }
  .body { padding: 14px 16px 16px; }
  [data-style='depth'] .body { padding: 16px 18px; }

  /* The progress track: 夜航 runs it along the card's top edge. */
  [data-style='hud'] .card { overflow: hidden; }
  .bar { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 3px; }
  .bar > span { height: 3px; background: var(--pg-todo); }
  .bar > .done { background: var(--pg-done); }
  .bar > .cur { background: var(--pg-cur); }
  .bar > .more { background: repeating-linear-gradient(90deg, var(--pg-todo) 0 5px, transparent 5px 9px); }
  :host([data-status='lost']) .bar > .cur, :host([data-status='lost']) .pips > .cur { background: var(--err); }
  /* 景深: a dot for each step walked, a pill for this one. */
  .pips { display: flex; align-items: center; gap: 4px; }
  .pips > span { width: 6px; height: 6px; border-radius: 999px; background: var(--pg-done); }
  .pips > .cur { width: 18px; background: var(--pg-cur); }

  /* 景深's card points at its target. */
  .pointer { display: none; }
  [data-style='depth'] .card:is([data-side='below'], [data-side='above']) .pointer:not([hidden]) {
    display: block; position: absolute; width: 14px; height: 14px;
    background: var(--o-bg); border: 1px solid var(--o-b); border-right: none; border-bottom: none;
    border-radius: 3px 0 0 0; clip-path: polygon(0 0, 100% 0, 0 100%);
  }
  .card[data-side='below'] .pointer { top: -7px; transform: rotate(45deg); }
  .card[data-side='above'] .pointer { bottom: -7px; transform: rotate(225deg); }

  .head { display: flex; align-items: center; gap: 8px; }
  .step-n { font-family: var(--font-label); font-size: 11px; font-weight: 600; letter-spacing: var(--ls-label); color: var(--acc-t); }
  [data-style='depth'] .step-n { font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--o-muted); }
  :host([data-status='lost']) [data-style='hud'] .step-n { color: var(--err); }
  .brand { margin-left: auto; font-family: var(--font-label); font-size: 10.5px; color: var(--o-muted); }
  .title { margin-top: 8px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  [data-style='depth'] .title { font-size: 18px; font-weight: 650; }
  .head[hidden] + .title { margin-top: 0; }
  :host([data-status='settling']) .title { color: var(--o-muted); }
  .detail { margin-top: 6px; font-size: 13px; line-height: 1.6; color: var(--o-fg-2); }
  .detail:empty, :host(:is([data-status='settling'], [data-status='lost'])) .detail { display: none; }
  :where(.m-text, .detail) :where(p, ul, ol) { margin: 0; }
  :where(.m-text, .detail) :where(ul, ol) { padding-left: 18px; }
  :where(.m-text, .detail) strong { color: var(--o-fg); }
  .m-text > * + *, .detail > * + * { margin-top: 6px; }
  code { font-family: var(--font-mono); font-size: .92em; padding: 1px 5px; border-radius: 4px; background: var(--o-val-bg); }

  /* What to type: shown, never typed for the user. */
  .value { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 8px 12px;
           border-radius: var(--r-field); background: var(--o-val-bg); }
  .v-label { flex-shrink: 0; font-family: var(--font-label); font-size: 10.5px; color: var(--o-muted); }
  .v-text { flex: 1; min-width: 0; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 13px; font-weight: 600;
            user-select: text; -webkit-user-select: text; }

  .notice { display: flex; align-items: flex-start; gap: 6px; margin-top: 10px; font-size: 12.5px; line-height: 1.55; font-weight: 500; color: var(--warn); }
  .notice svg, .waiting svg { flex-shrink: 0; margin-top: 2px; }
  .notice:has(.n-text:empty) { display: none; }
  :host([data-status='lost']) .notice { color: var(--err); }
  :host([data-status='settling']) .notice { color: var(--acc-t); align-items: center; }
  .spin { display: none; width: 13px; height: 13px; flex-shrink: 0; border: 2px solid var(--acc-soft); border-top-color: var(--acc-t);
          border-radius: 50%; animation: spin .8s linear infinite; }
  :host([data-status='settling']) .spin { display: block; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .waiting { display: flex; gap: 8px; margin-top: 10px; padding: 10px 12px; border-radius: var(--r-field);
             background: var(--acc-soft); color: var(--o-fg); font-size: 12.5px; line-height: 1.6; }
  /* What the step was looking for: said on the lost screen only (StepView.looking). */
  .looking { display: none; font-size: 11px; margin-top: 8px; padding: 6px 10px; border-radius: 6px;
             background: var(--o-val-bg); color: var(--o-muted); font-family: var(--font-mono); }
  :host([data-status='lost']) .looking:not(:empty) { display: block; }

  .row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .kbd { margin-left: auto; font-family: var(--font-label); font-size: 10.5px; color: var(--o-muted); }
  :host(:not([data-status='shown'])) .kbd { display: none; }
  button {
    font: inherit; font-size: 13px; height: 34px; padding: 0 14px; border-radius: var(--r-ctl); cursor: pointer;
    border: 1px solid var(--g-b); background: var(--g-bg); color: var(--g-fg);
  }
  button.primary { padding: 0 16px; font-weight: 600; border-color: transparent; background: var(--p-bg); color: var(--p-fg); box-shadow: var(--p-shadow); }
  [data-style='depth'] button { height: 36px; font-size: 13.5px; }
  button:hover:not(:disabled) { filter: brightness(0.95); }
  button:disabled { opacity: .4; cursor: default; box-shadow: none; }
  button:focus-visible { outline: 2px solid var(--f-focus); outline-offset: 2px; }

  /* The message card: what is not a step, in the corner. */
  .message { right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px)); padding: 14px 16px 16px; }
  .m-head { display: flex; align-items: center; gap: 8px; }
  .m-icon { width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
            border-radius: var(--r-icon); background: var(--acc-soft); color: var(--acc-t); }
  [data-style='hud'] .m-icon { border-radius: 6px; }
  .message[data-kind='cross_site'] .m-icon { background: var(--warn-soft); color: var(--warn); }
  .message[data-kind='note'] .m-icon { background: var(--o-val-bg); color: var(--o-muted); }
  .m-title { font-size: 15px; font-weight: 650; }
  .m-text { margin-top: 8px; font-size: 13.5px; line-height: 1.65; color: var(--o-fg-2); white-space: pre-wrap; max-height: 40vh; overflow: auto; }

  /* The inspector's hover: which control a click would pick. */
  .peek { padding: 8px 10px; border-radius: var(--r-field); max-width: 280px; pointer-events: none; }
  .p-id { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .p-role { flex-shrink: 0; padding: 1px 6px; border-radius: 4px; background: var(--o-val-bg);
            font-family: var(--font-mono); font-size: 10.5px; color: var(--o-muted); }
  .p-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .p-hint { margin-top: 3px; font-size: 11.5px; color: var(--o-muted); }

  @media (prefers-reduced-motion: reduce) {
    .ring::after, .spin { animation: none; }
    .ring { transition: none; }
  }
</style>
<div class="theme">
<div class="veil" style="display:none"></div>
<div class="rings"></div>
<div class="card" style="display:none">
  <i class="pointer"></i>
  <div class="bar for-hud"></div>
  <div class="body">
    <div class="head">
      <span class="pips for-depth"></span>
      <span class="step-n"><span class="for-hud"></span><span class="for-depth"></span></span>
      <span class="brand">页面引导</span>
    </div>
    <div class="title"></div>
    <div class="detail"></div>
    <div class="value" hidden><span class="v-label">照着填</span><span class="v-text"></span></div>
    <div class="notice"><span class="spin"></span><span class="n-icon"></span><span class="n-text"></span></div>
    <div class="waiting" hidden>${INFO}<span>${WAITING_FOR_PANEL_TEXT}</span></div>
    <div class="looking"></div>
    <div class="row step-actions">
      <button class="btn-next primary" title="把焦点移到目标上，之后按回车或空格即可触发——扩展不代你操作">跳到目标</button>
      <button class="btn-exit">结束</button>
      <span class="kbd">聚焦后按 Enter</span>
    </div>
    <div class="row lost-actions" hidden>
      <button class="btn-retry primary">重试定位</button>
      <button class="btn-exit">结束引导</button>
    </div>
  </div>
</div>
<div class="peek" style="display:none">
  <div class="p-id"><span class="p-role"></span><span class="p-name"></span></div>
  <div class="p-hint">点一下选中，这一下不会传给页面</div>
</div>
<div class="message" hidden>
  <div class="m-head"><span class="m-icon"></span><span class="m-title"></span></div>
  <div class="m-text"></div>
  <div class="row m-close">
    <button class="btn-m-close">关闭</button>
  </div>
  <div class="row m-choose">
    <button class="btn-m-go primary">继续，带我去</button>
    <button class="btn-m-stay">先不去</button>
  </div>
</div>
</div>`;
