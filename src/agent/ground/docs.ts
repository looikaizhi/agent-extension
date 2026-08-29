import { structuralRedFlags, type RedFlag } from '@/core/security/link-safety';
import type { Ref } from '@/shared/types';

/**
 * Whether a page's own link may be fetched as documentation — decided here,
 * fetched elsewhere.
 *
 * This function performs no network access of any kind, and that is the whole
 * arrangement: 设计文档 §8.3 puts the judgement in the service worker and the
 * fetching in the panel, so what crosses that boundary is always an address
 * that has already been approved. A panel that could decide for itself would
 * be a second place to weaken the rules.
 *
 * Only source ① of §6.1 (a link the page itself offers) is in scope. The
 * model's prior URLs and site search are not: S-07 already answered "what is
 * in range" by making the model output refs and never URLs, so the address
 * always comes from a link that really exists on the page the user is looking
 * at, and the page vouches for it.
 */
export type GroundDecision = { ok: true; url: string } | { ok: false; reason: RedFlag | 'unresolvable' };

export function groundFromPageLink(_viaRef: Ref, resolvedHref: string | undefined, _currentUrl: string): GroundDecision {
  // The ref resolved to nothing, or to something that is not a link. The page
  // may have changed between the model naming it and the host reading it
  // (§5.3's general rule) — a lookup that finds nothing says so.
  if (!resolvedHref) return { ok: false, reason: 'unresolvable' };

  let url: URL;
  try {
    url = new URL(resolvedHref);
  } catch {
    // Never hand an unvalidated string onwards. Anything the browser itself
    // could not parse is not an address.
    return { ok: false, reason: 'unresolvable' };
  }

  const flag = structuralRedFlags(url);
  if (flag) return { ok: false, reason: flag };

  return { ok: true, url: url.toString() };
}
