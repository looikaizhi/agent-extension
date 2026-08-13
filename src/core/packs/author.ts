import type { PromptItem, PromptTable } from '@/core/extractor/types';
import { type ElementDescriptor, actionForRole } from '@/shared/protocol';
import { bindStep } from './bind';

/**
 * Turn a picked element into the weakest descriptor that still identifies it.
 *
 * L-0 is a *constraint*, not a statistic: §7.5 puts the authoring-time
 * uniqueness rate at 100%, mandatory. The reason is the asymmetry between the
 * failure classes — L-2 (several candidates) and L-3 (none) both surface as
 * visible product behaviour and the user is never misled, while **L-4 (exactly
 * one match, and it is the wrong element) is silent**: the user goes and clicks
 * the wrong button. A descriptor that is not unique at the moment it is written
 * is an L-4 waiting to happen, so the inspector must refuse to pretend.
 *
 * Weakest-first matters as much as uniqueness. Every extra field is another
 * thing that can change when the page is redesigned, so `nth` — which is pure
 * position and survives nothing — comes last and marks the step fragile.
 */
export interface Authored {
  descriptor: ElementDescriptor;
  /** How many elements it matches right now. Anything but 1 is a defect. */
  matches: number;
  /** True when the single match is genuinely the element that was picked. */
  correct: boolean;
  /** Which rung of the ladder was needed; higher means more brittle. */
  rung: 'name' | 'scope' | 'outer-scope' | 'nth';
}

export function authorDescriptor(item: PromptItem, table: PromptTable): Authored {
  const base = { role: item.role, name: item.name };
  const path = item.path;
  const inner = path.length ? path[path.length - 1] : undefined;
  const outer = path.length > 1 ? path[0] : undefined;

  const ladder: Array<{ rung: Authored['rung']; d: ElementDescriptor }> = [
    { rung: 'name', d: base },
    ...(inner ? [{ rung: 'scope' as const, d: { ...base, scope: inner } }] : []),
    ...(outer ? [{ rung: 'outer-scope' as const, d: { ...base, scope: outer } }] : []),
    ...(item.nth !== undefined
      ? [{ rung: 'nth' as const, d: { ...base, ...(inner ? { scope: inner } : {}), nth: item.nth } }]
      : []),
  ];

  for (const { rung, d } of ladder) {
    const r = bindStep(d, table);
    // Unique *and* the right one. Counting matches without checking identity is
    // exactly how an L-4 gets certified as safe.
    if (r.kind === 'unique') {
      if (r.ref === item.ref) return { descriptor: d, matches: 1, correct: true, rung };
      return { descriptor: d, matches: 1, correct: false, rung };
    }
  }

  const last = ladder[ladder.length - 1]!;
  const r = bindStep(last.d, table);
  return {
    descriptor: last.d,
    matches: r.kind === 'ambiguous' ? r.refs.length : 0,
    correct: false,
    rung: last.rung,
  };
}

/** The pack-file form, so an authored step can be pasted straight into a pack. */
export function toPackYaml(a: Authored, title: string): string {
  const d = a.descriptor;
  const lines = [
    `- title: ${JSON.stringify(title)}`,
    `  expectedUserAction: ${actionForRole(d.role)}`,
    `  target:`,
    `    role: ${d.role}`,
    `    name: ${JSON.stringify(d.name)}`,
  ];
  if (d.nameMatch) lines.push(`    nameMatch: ${d.nameMatch}`);
  if (d.scope) lines.push(`    scope: ${JSON.stringify(d.scope)}`);
  if (d.nth !== undefined) lines.push(`    nth: ${d.nth}   # 脆弱：纯位置，改版即失效`);
  return lines.join('\n');
}
