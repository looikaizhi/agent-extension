import { LANDMARK_ROLES } from './roles';
import type { UINode } from './types';

/** FNV-1a 32-bit: extraction is fully synchronous and crypto.subtle is not.
 *  This is an equality key, not a security primitive. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Route + landmark/heading structure only.
 *
 * Deliberately NOT sensitive to interactive elements: §4.5 invalidates the step
 * sequence whenever this changes, so a hash that reacts to every button
 * appearing after an async load would invalidate the guide constantly.
 */
/**
 * Only `role`/`name` are ever read below — widened from `readonly UINode[]`
 * so a registry-free, landmark/heading-only caller
 * (`extract.ts`'s `extractPageHash`) can hand this function bare `{role,
 * name}` pairs without fabricating the rest of a `UINode`'s fields. Every
 * existing `UINode[]` caller still satisfies this structurally — nothing
 * about accepting *less* required data narrows what already worked. */
export function pageFingerprint(nodes: readonly Pick<UINode, 'role' | 'name'>[]): string {
  const structure = nodes
    .filter((n) => LANDMARK_ROLES.has(n.role) || n.role === 'heading')
    .slice(0, 24)
    .map((n) => `${n.role}|${n.name}`)
    .join('\n');
  return fnv1a(`${location.origin}${location.pathname}\n${structure}`);
}

/**
 * First of two independent layers: "连内容脚本都不应该在明知
 * 没变的情况下发消息". `pageFingerprint` is already, by construction,
 * insensitive to anything other than landmark/heading structure (this file's
 * own doc comment above) — so the decision of whether a freshly computed hash
 * is worth reporting is nothing more than string inequality. Pulled out as
 * its own named export purely so it is unit-testable without a live
 * `document`/`location` (`pageFingerprint` itself needs both); the content
 * script's own `MutationObserver` wiring that calls this is 05's e2e-only
 * half (slices 7/10), never unit-tested directly.
 */
export function pageStructureChanged(previousHash: string | null, nextHash: string): boolean {
  return previousHash !== nextHash;
}
