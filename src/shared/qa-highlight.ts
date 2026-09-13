import { descriptorOf } from '@/core/descriptor/bind';
import type { PromptItem } from '@/core/extractor/types';
import type { GuideStep, HighlightAck } from './protocol';

/**
 * Host-side gate for `PANEL_SHOW_QA_RESULT`.
 *
 * The model can take several seconds to answer, and the user is free to
 * navigate during that time. Comparing `tab.url` against the URL the question
 * was asked against is the one check that only the host can make — it reads
 * `chrome.tabs.get`, which `content.ts` has no access to — and it only ever
 * catches a whole-page navigation. The narrower "same URL, but the SPA
 * re-rendered" case is a *renderer* concern and is handled by the `mode`
 * branch in `content.ts`'s `render()` instead: this function
 * cannot see that far, and must not try to.
 */
export function checkPageIdentity(
  requestUrl: string,
  tabUrl: string,
): { ok: true } | { ok: false; reason: string } {
  if (requestUrl === tabUrl) return { ok: true };
  return { ok: false, reason: '页面已经变化，这条回答引用的位置可能已经不对了。' };
}

/**
 * Turns a QA answer's referenced elements into the `GuideStep` its highlight
 * renders from.
 *
 * `items` are already-resolved `PromptItem`s — the panel looks them up from
 * its own `PANEL_EXTRACT` table before sending `PANEL_SHOW_QA_RESULT`, the
 * same way `App.tsx`'s `onRowClick` does — not bare refs. That is what lets
 * this function reuse `descriptorOf` (`src/core/descriptor/bind.ts`) instead of
 * inventing a second ref → `ElementDescriptor` path, and it is why no fresh
 * extraction happens on the host: re-extracting here would commit a new
 * snapshot generation in the content script's registry and make the *original*
 * `snapshotId` unresolvable, so `explain` would report `snapshot_stale` on
 * every single call — the fast path the explain branch depends on would never fire.
 *
 * `null` when there is nothing to highlight: the answer stands on its own.
 */
export function buildQaStep(
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

/** What `PANEL_SHOW_QA_RESULT` answers with. Not part of `ContentRpcMap` — the
 *  panel talks to the host, not the content script, and the host adds one
 *  field the content script cannot know: whether a guide is parked on this
 *  tab (the ownership query — the only thread access this whole channel ever
 *  makes). */
export type QaHighlightResponse =
  | { ok: true; data: { guideActive: boolean; highlight: HighlightAck | null } }
  | { ok: false; code: 'page_changed'; message: string };

/**
 * Assembles the response once the identity check, the ownership query, and
 * (if applicable) the forwarded `HIGHLIGHT` result are all in hand.
 *
 * `guideActive` passes straight through — this function does not know or
 * care where it came from, so slice 8 ("guideActive 与当时的所有权查询结果
 * 一致") tests it directly with a boolean, no `chrome.*` needed.
 */
export function buildQaResponse(
  identity: { ok: true } | { ok: false; reason: string },
  guideActive: boolean,
  highlight: HighlightAck | null,
): QaHighlightResponse {
  if (!identity.ok) return { ok: false, code: 'page_changed', message: identity.reason };
  return { ok: true, data: { guideActive, highlight } };
}
