import type { HighlightAck } from '@/shared/protocol';
import type { Binding } from './thread';

/**
 * The missing piece between renderer and reducer: `HighlightAck` → `Binding`.
 *
 * `machine.ts`'s `handleBindResult` (03) already knows what to *do* with a
 * `Binding` value — the CL-2 escalation, the "未能定位" fallback — but until
 * this file existed, nothing ever produced one from a real paint attempt. The
 * retired host flattened every non-success `HighlightAck` into a single coarse
 * `'unresolved'` signal, which loses
 * exactly the distinction CL-2 exists to use: "several elements matched, ask
 * the user to pick" reads nothing like "nothing matched at all". This
 * function is the missing translation, kept pure and separate from
 * `machine.ts` itself (whose own doc comment reserves that file for `step`
 * and nothing else) so it can be unit-tested without a live DOM.
 *
 * The three-way split mirrors `content.ts`'s own `render()`, which is the
 * only producer of a real `HighlightAck`:
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
