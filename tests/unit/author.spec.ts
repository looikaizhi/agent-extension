import { describe, expect, it } from 'vitest';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import { authorDescriptor, toPackYaml } from '@/core/packs/author';
import { bindStep } from '@/core/packs/bind';
import type { Ref } from '@/shared/types';

type Spec = { ref: string; role: string; name: string; path?: string[]; nth?: number };

function table(items: Spec[]): PromptTable {
  return {
    snapshotId: 's1',
    url: 'https://example.test/',
    title: 't',
    pageHash: 'h',
    truncated: false,
    degraded: false,
    ambiguity: 0,
    stats: {
      elementsScanned: 0,
      candidates: 0,
      visible: 0,
      emitted: 0,
      shadowRoots: 0,
      emptyName: 0,
      modalScoped: false,
      ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
    },
    items: items.map((i) => ({
      ref: i.ref as unknown as Ref,
      role: i.role,
      name: i.name,
      path: i.path ?? [],
      ...(i.nth !== undefined ? { nth: i.nth } : {}),
    })),
  };
}
const at = (t: PromptTable, ref: string) => t.items.find((i) => i.ref === ref)!;

describe('authorDescriptor —— L-0 是约束，不是统计量', () => {
  it('唯一时用最弱的形式：只有 role + name', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Save', path: ['Billing'] },
      { ref: 'e2', role: 'button', name: 'Cancel', path: ['Billing'] },
    ]);
    const a = authorDescriptor(at(t, 'e1'), t);
    expect(a).toMatchObject({ matches: 1, correct: true, rung: 'name' });
    // Every extra field is another thing a redesign can break, so an
    // unnecessary `scope` is a defect, not harmless caution.
    expect(a.descriptor).toEqual({ role: 'button', name: 'Save' });
  });

  it('重名时才加 scope', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', path: ['Payment methods'] },
      { ref: 'e2', role: 'button', name: 'Copy', path: ['Webhooks'] },
    ]);
    const a = authorDescriptor(at(t, 'e2'), t);
    expect(a).toMatchObject({ matches: 1, correct: true, rung: 'scope' });
    expect(a.descriptor).toEqual({ role: 'button', name: 'Copy', scope: 'Webhooks' });
  });

  it('内层 scope 也不够时退到外层', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Stop', path: ['Prod', 'row'] },
      { ref: 'e2', role: 'button', name: 'Stop', path: ['Staging', 'row'] },
    ]);
    const a = authorDescriptor(at(t, 'e2'), t);
    expect(a).toMatchObject({ matches: 1, correct: true, rung: 'outer-scope' });
    expect(a.descriptor.scope).toBe('Staging');
  });

  it('都不行时才落到 nth，并标记为最脆弱的一档', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', nth: 1 },
      { ref: 'e2', role: 'button', name: 'Copy', nth: 2 },
      { ref: 'e3', role: 'button', name: 'Copy', nth: 3 },
    ]);
    const a = authorDescriptor(at(t, 'e2'), t);
    expect(a).toMatchObject({ matches: 1, correct: true, rung: 'nth' });
    expect(a.descriptor.nth).toBe(2);
  });

  it('无论走到哪一档，产出的 descriptor 都必须绑回被选中的那个元素', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', path: ['A'], nth: 1 },
      { ref: 'e2', role: 'button', name: 'Copy', path: ['A'], nth: 2 },
      { ref: 'e3', role: 'button', name: 'Copy', path: ['B'] },
      { ref: 'e4', role: 'link', name: 'Copy', path: ['A'] },
    ]);
    for (const item of t.items) {
      const a = authorDescriptor(item, t);
      expect([item.ref, a.correct]).toEqual([item.ref, true]);
      expect(bindStep(a.descriptor, t)).toMatchObject({ kind: 'unique', ref: item.ref });
    }
  });

  it('真的无法唯一时如实报告，而不是硬凑一个', () => {
    // No path, no nth, three identical: nothing in the vocabulary separates
    // them. Reporting `matches: 3` is the honest answer — a descriptor that
    // *looks* unique but is not is exactly how an L-4 is born.
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy' },
      { ref: 'e2', role: 'button', name: 'Copy' },
      { ref: 'e3', role: 'button', name: 'Copy' },
    ]);
    const a = authorDescriptor(at(t, 'e2'), t);
    expect(a.correct).toBe(false);
    expect(a.matches).toBe(3);
  });

  it('命中 1 个但不是被选中的那个，判为不正确', () => {
    // The L-4 shape: a count of one is not proof of correctness.
    const t = table([
      { ref: 'e1', role: 'button', name: 'Save' },
      { ref: 'e2', role: 'button', name: 'Save', path: ['Elsewhere'] },
    ]);
    // e1 has no path, so its ladder starts and ends at {role,name} — which
    // matches both, so it cannot be certified.
    expect(authorDescriptor(at(t, 'e1'), t).correct).toBe(false);
  });
});

describe('toPackYaml', () => {
  it('产出可直接粘进引导包的片段，并标注脆弱字段', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', nth: 1 },
      { ref: 'e2', role: 'button', name: 'Copy', nth: 2 },
    ]);
    const yaml = toPackYaml(authorDescriptor(at(t, 'e2'), t), 'Copy the secret');
    expect(yaml).toContain('role: button');
    expect(yaml).toContain('nth: 2');
    expect(yaml).toContain('脆弱');
  });

  it('动作由 role 推出，不再一律 click', () => {
    // The defect: every picked element produced `expectedUserAction: click`, so
    // picking a text field authored a step telling the user to click it. The
    // card renders this value, so it was visible to the user and silent to us.
    const t = table([
      { ref: 'e1', role: 'textbox', name: 'Cluster name' },
      { ref: 'e2', role: 'checkbox', name: 'Enable logging' },
      { ref: 'e3', role: 'combobox', name: 'Region' },
      { ref: 'e4', role: 'button', name: 'Create' },
    ]);
    const action = (ref: string) =>
      toPackYaml(authorDescriptor(at(t, ref), t), 'x').match(/expectedUserAction: (\w+)/)![1];
    expect(action('e1')).toBe('input');
    expect(action('e2')).toBe('toggle');
    expect(action('e3')).toBe('select');
    expect(action('e4')).toBe('click');
  });
});
