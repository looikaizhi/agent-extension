/**
 * 外观（CONTEXT.md `Appearance`）：风格与明暗，是用户的偏好。
 *
 * Pure on purpose — no `chrome.*` — because the page side reads it too. The
 * overlay is told the appearance by the host (`THEME`); it cannot read storage
 * (the key lives there), and 跟随系统 can only be resolved by a document, which
 * is the one thing able to ask `prefers-color-scheme`. Storage is
 * `appearance-store.ts`, which the page side never imports.
 */

/** 夜航（等宽标注、荧光绿、取景框）或景深（毛玻璃、虚化聚焦、胶囊按钮）。 */
export type Style = 'hud' | 'depth';
/** What the user chose. */
export type Mode = 'system' | 'day' | 'night';
/** What gets painted: `Mode` with 跟随系统 resolved. */
export type Shade = 'day' | 'night';

export interface Appearance {
  style: Style;
  mode: Mode;
}

export const DEFAULT_APPEARANCE: Appearance = { style: 'depth', mode: 'system' };

/** Anything that is not one of the words above reads as the default — a
 *  corrupt stored value costs a look, never a broken screen. */
export function asAppearance(v: unknown): Appearance {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof Appearance, unknown>>;
  return {
    style: o.style === 'hud' || o.style === 'depth' ? o.style : DEFAULT_APPEARANCE.style,
    mode: o.mode === 'system' || o.mode === 'day' || o.mode === 'night' ? o.mode : DEFAULT_APPEARANCE.mode,
  };
}

export const shadeOf = (mode: Mode, systemDark: boolean): Shade => (mode === 'system' ? (systemDark ? 'night' : 'day') : mode);

/**
 * Keeps `el`'s `data-style` / `data-shade` — the two attributes the theme tokens
 * (`theme/tokens.css`) key on — in step with an appearance, and for 跟随系统 with
 * the system as it changes. Returns the function that stops following it.
 */
export function applyAppearance(el: HTMLElement, a: Appearance): () => void {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const paint = () => {
    el.dataset.style = a.style;
    el.dataset.shade = shadeOf(a.mode, dark.matches);
  };
  paint();
  if (a.mode !== 'system') return () => {};
  dark.addEventListener('change', paint);
  return () => dark.removeEventListener('change', paint);
}
