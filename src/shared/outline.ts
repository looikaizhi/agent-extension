import { descriptorOf } from '@/core/descriptor/bind';
import type { PromptItem } from '@/core/extractor/types';
import type { GuideStep } from './protocol';

/**
 * Turns the elements an answer names — what backs an `explain` up, or the
 * candidates an `ask` lists — into the `GuideStep` their outline renders from.
 *
 * `items` are already-resolved `PromptItem`s from the table the answer was
 * checked against, not bare refs. That is what lets this function reuse
 * `descriptorOf` (`src/core/descriptor/bind.ts`) instead of inventing a second
 * ref → `ElementDescriptor` path, and it is why no fresh extraction happens
 * before painting: re-extracting would commit a new snapshot generation in the
 * content script's registry and make the answer's `snapshotId` unresolvable,
 * so `explain` mode would report `snapshot_stale` every time.
 *
 * `null` when there is nothing to outline: the answer stands on its own.
 */
export function buildOutline(
  items: readonly PromptItem[],
  title: string,
  detail?: string,
): GuideStep | null {
  if (items.length === 0) return null;

  const base: Omit<GuideStep, 'ref' | 'alsoRefs'> = {
    // Never used to choose *which* element for the user (K-6): with one item
    // it is the item; with several it is only ever the "找的是" display hint,
    // never read by `bindHere()` — `mode: 'explain'` never rebinds.
    descriptor: descriptorOf(items[0]!),
    expectedUserAction: 'observe',
    title,
    ...(detail !== undefined ? { detail } : {}),
  };

  // A confident single reference gets `ref`. Several candidates go through
  // `alsoRefs` instead — setting `ref` here would silently pick the first one
  // for the user, which is exactly the K-6 violation this channel exists to
  // avoid (§7 of 06: "设了 ref 就等于替用户选了第一个").
  return items.length === 1 ? { ...base, ref: items[0]!.ref } : { ...base, alsoRefs: items.map((i) => i.ref) };
}
