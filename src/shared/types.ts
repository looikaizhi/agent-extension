/** Frame-qualified element handle. `e{n}` for the top frame, `f{frameId}e{n}` otherwise.
 *  Valid only within one snapshot — see K-1 in step1-implementation-plan.md. */
export type Ref = string & { readonly __brand: 'Ref' };

export const makeRef = (frameId: number, n: number): Ref =>
  (frameId === 0 ? `e${n}` : `f${frameId}e${n}`) as Ref;

/** Bounding box in the *owning frame's* viewport coordinates, rounded. */
export type Rect = readonly [x: number, y: number, w: number, h: number];

export type UIState =
  | 'disabled'
  | 'readonly'
  | 'required'
  | 'invalid'
  | 'checked'
  | 'mixed'
  | 'selected'
  | 'expanded'
  | 'collapsed'
  | 'current'
  | 'busy';

export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label'
  | 'content'
  | 'placeholder'
  | 'title'
  | 'alt'
  | 'value'
  | 'testid'
  | 'href'
  | 'none';
