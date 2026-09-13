/**
 * CONTEXT.md's `Place`: whether two addresses are the same place — origin +
 * pathname only, so a query string that gained a tracking parameter is not a
 * different page.
 *
 * The one definition every judgement of it uses. It used to be written three
 * times, and a rule written more than once is a rule that drifts.
 */
export function samePlace(a: string, b: string): boolean {
  return placeOf(a) === placeOf(b);
}

/** An address that does not parse is compared as written. */
function placeOf(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}
