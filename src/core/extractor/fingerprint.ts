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
export function pageFingerprint(nodes: readonly UINode[]): string {
  const structure = nodes
    .filter((n) => LANDMARK_ROLES.has(n.role) || n.role === 'heading')
    .slice(0, 24)
    .map((n) => `${n.role}|${n.name}`)
    .join('\n');
  return fnv1a(`${location.origin}${location.pathname}\n${structure}`);
}
