import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { ElementDescriptor } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

/**
 * Binding never picks a winner.
 *
 * Silent mis-binding can only be born from "choose one of several candidates".
 * Removing that action collapses the whole failure class down to "uniquely
 * matched, but the one match was wrong" — which is a content problem the
 * authoring-time uniqueness check is designed to catch. This is a type-level
 * guarantee, not a runtime assertion (K-6).
 */
export type BindResult =
  | { kind: 'unique'; ref: Ref; item: PromptItem }
  | { kind: 'ambiguous'; refs: Ref[]; items: PromptItem[] }
  | { kind: 'not_found' };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function nameMatches(item: PromptItem, d: ElementDescriptor): boolean {
  const a = norm(item.name);
  const b = norm(d.name);
  switch (d.nameMatch ?? 'exact') {
    case 'exact':
      return a === b;
    case 'contains':
      return a.includes(b);
    case 'fuzzy':
      return a.includes(b) || b.includes(a);
  }
}

/**
 * Conjunctive filter: every field present on the descriptor must hold. No
 * scoring, no weighting, no tie-break — so the behaviour of a hand-written
 * field is predictable to the author.
 */
export function bindStep(d: ElementDescriptor, table: PromptTable): BindResult {
  let candidates = table.items.filter((it) => it.role === d.role && nameMatches(it, d));

  if (d.scope) {
    const s = norm(d.scope);
    candidates = candidates.filter((it) => it.path.some((p) => norm(p).includes(s)));
  }
  if (d.nth !== undefined) {
    const picked = candidates.filter((it) => it.nth === d.nth);
    // An explicit nth that matches nothing is a failure, not a licence to guess.
    candidates = picked;
  }

  if (candidates.length === 0) return { kind: 'not_found' };
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { kind: 'unique', ref: only.ref, item: only };
  }
  return {
    kind: 'ambiguous',
    refs: candidates.map((c) => c.ref),
    items: candidates,
  };
}

/** Authoring-time helper: how many elements does this descriptor match right now? */
export function matchCount(d: ElementDescriptor, table: PromptTable): number {
  const r = bindStep(d, table);
  return r.kind === 'unique' ? 1 : r.kind === 'ambiguous' ? r.refs.length : 0;
}

/** Build a descriptor from a live table item — used by the inspector. */
export function descriptorOf(item: PromptItem): ElementDescriptor {
  const d: ElementDescriptor = { role: item.role, name: item.name };
  if (item.path.length) d.scope = item.path[item.path.length - 1];
  if (item.nth !== undefined) d.nth = item.nth;
  return d;
}
