import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/** What an agent's `validate` hands back: the envelope it was given, or why it
 *  is refused. */
export type ValidateResult<E> = { kind: 'ok'; envelope: E } | { kind: 'violation'; reason: string };

/**
 * R-a and R-e, the two rules every answer is held to whichever agent wrote it
 * (design doc §5.6): every ref it claims is on the table it was written
 * against, and none of them is sensitive. The reason it is refused, or `null`.
 *
 * A single loop, never a `.filter()`: one illegal member anywhere in the
 * claimed set fails the *whole* envelope ("数组里出现任意一个非法成员 → 整体判
 * 失败"). There is no "keep the legal ones" path here.
 */
export function refsViolation(refs: readonly Ref[], table: PromptTable): string | null {
  const itemByRef = new Map<Ref, PromptItem>(table.items.map((i) => [i.ref, i]));
  for (const ref of refs) {
    const item = itemByRef.get(ref);
    if (!item) return `ref「${ref}」不在本次快照内`; // R-a
    if (item.sensitive) return `ref「${ref}」指向敏感元素，不可引用`; // R-e
  }
  return null;
}
