import type { Rect } from '@/shared/types';

/**
 * Where the overlay's pieces go, as arithmetic on rectangles — nothing here
 * reads the page, so all of it runs without one.
 */

/** How far the ring and the hole stand off the target's own edges. */
export const PAD = 4;
/** Corner radius of a hole, the same as the ring drawn around it. */
const HOLE_R = 8;
/** Between the target and the card: the ring, and room for the card's pointer. */
const GAP = 18;
/** Nothing is placed closer than this to the viewport's edge. */
const EDGE = 8;

type Box = readonly [x: number, y: number, w: number, h: number];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const padded = ([x, y, w, h]: Rect): Box => [x - PAD, y - PAD, w + PAD * 2, h + PAD * 2];
const within = (a: Box, b: Box) => a[0] >= b[0] && a[1] >= b[1] && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3];

function roundedBox([x, y, w, h]: Box): string {
  const r = Math.min(HOLE_R, w / 2, h / 2);
  return (
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}` +
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  );
}

/**
 * The veil: the whole viewport, less one rounded hole per target — a
 * `clip-path` rather than an SVG mask, because only an element can blur what
 * is behind it (景深's 目标以外虚化).
 *
 * Even-odd, so each hole is cut rather than filled. A hole that sits inside
 * another would be filled back in by the same rule, so it is dropped: it
 * uncovers nothing the larger one does not.
 */
export function veilPath(vw: number, vh: number, rects: readonly Rect[]): string {
  const boxes = rects.map(padded);
  const holes = boxes.filter((a, i) => !boxes.some((b, j) => j !== i && within(a, b) && (!within(b, a) || j < i)));
  return [`M0 0H${vw}V${vh}H0Z`, ...holes.map(roundedBox)].join(' ');
}

export interface CardPlace {
  left: number;
  top: number;
  /** Which side of the target the card went to; `free` when there is no
   *  target on screen to sit beside. */
  side: 'below' | 'above' | 'free';
  /** Where along the card's edge the pointer meets it, from the card's left;
   *  `null` when there is nothing to point at. */
  pointerX: number | null;
}

/**
 * The step card beside its target: below it when it fits, above it when that
 * fits instead. A target off screen, or none at all, puts the card where it
 * can be read — the card is what says where the target went.
 */
export function placeCard(rect: Rect | null, vw: number, vh: number, cw: number, ch: number): CardPlace {
  const inView = (top: number) => clamp(top, EDGE, vh - ch - EDGE);
  if (!rect) return { left: Math.round((vw - cw) / 2), top: Math.round(inView(vh / 2 - ch / 2)), side: 'free', pointerX: null };

  const [x, y, w, h] = rect;
  const left = Math.round(clamp(x, EDGE, vw - cw - EDGE));
  if (y + h < 0) return { left, top: EDGE, side: 'free', pointerX: null };
  if (y > vh) return { left, top: Math.round(vh - ch - EDGE), side: 'free', pointerX: null };

  const pointerX = Math.round(clamp(x + w / 2 - left, 20, cw - 20));
  if (y + h + GAP + ch <= vh - EDGE) return { left, top: y + h + GAP, side: 'below', pointerX };
  if (y - GAP - ch >= EDGE) return { left, top: y - GAP - ch, side: 'above', pointerX };
  // Too tall to sit beside: over it, kept on screen, pointing at nothing.
  return { left, top: Math.round(inView(y + h + GAP)), side: 'free', pointerX: null };
}

/** The smallest rectangle around all of them: what a card for several
 *  candidates sits beside, so it covers none of them. */
export function bounds(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r[0]));
  const y = Math.min(...rects.map((r) => r[1]));
  const right = Math.max(...rects.map((r) => r[0] + r[2]));
  const bottom = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x, y, right - x, bottom - y];
}

/** The inspector's label: under the outline, flush with its right edge — or
 *  over it, when there is no room below. */
export function placePeek(rect: Rect, vw: number, vh: number, pw: number, ph: number): { left: number; top: number } {
  const [x, y, w, h] = padded(rect);
  const left = Math.round(clamp(x + w - pw, EDGE, vw - pw - EDGE));
  const below = y + h + 8;
  const top = below + ph <= vh - EDGE ? below : Math.max(EDGE, y - 8 - ph);
  return { left, top: Math.round(top) };
}
