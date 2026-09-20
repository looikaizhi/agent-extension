import type { HighlightAck } from '@/shared/protocol';

/**
 * CONTEXT.md's renderer-stamped axis: "此刻能不能把它指出来". Distinct from
 * `core/descriptor/bind.ts`'s `BindResult` — that is a table-only match
 * attempt; this is what a real paint attempt against the page on screen came
 * back with.
 *
 * Shown to the side panel beside the step, and nothing more. It is never fed
 * back into the Thread: by the time a paint answers, the step it names may no
 * longer be the one on screen — a paint cut short by the next command, or by a
 * CLEAR, answers `ref_not_found` too, and the old reducer wrote that down
 * against whatever step held the tab by then. What a paint says about the step
 * itself arrives as a reading instead (CONTEXT.md `Reading`), matched to the
 * presentation it was about.
 */
export type Binding = 'bound' | 'ambiguous' | 'unbound';

/**
 * `HighlightAck` → `Binding`, in the three ways `content.ts`'s `render()`
 * can answer:
 *  - `resolved !== null` — exactly one element was painted. `bound`.
 *  - `resolved === null` but `candidates` is a non-empty list — several
 *    elements were painted with none singled out (K-6: bind never breaks a
 *    tie). `ambiguous`.
 *  - anything else — a `failure` was set and nothing (or only the "lost"
 *    screen) was painted. `unbound`.
 */
export function bindingFromAck(ack: HighlightAck): Binding {
  if (ack.resolved !== null) return 'bound';
  if (ack.candidates && ack.candidates.length > 0) return 'ambiguous';
  return 'unbound';
}
