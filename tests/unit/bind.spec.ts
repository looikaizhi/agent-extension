import { describe, expect, it } from 'vitest';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import { bindStep, descriptorOf, matchCount } from '@/core/descriptor/bind';
import type { ElementDescriptor } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

function table(items: ItemSpec[]): PromptTable {
  return {
    snapshotId: 's1',
    url: 'https://example.test/',
    title: 't',
    structureHash: 'h',
    omitted: 0,
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

const d = (o: Partial<ElementDescriptor> & { role: string; name: string }): ElementDescriptor => o;

describe('bindStep', () => {
  it('唯一命中', () => {
    const r = bindStep(d({ role: 'button', name: 'Save' }), table([{ ref: 'e1', role: 'button', name: 'Save' }]));
    expect(r).toEqual({ kind: 'unique', ref: 'e1', item: expect.anything() });
  });

  it('无命中', () => {
    const r = bindStep(d({ role: 'button', name: 'Nope' }), table([{ ref: 'e1', role: 'button', name: 'Save' }]));
    expect(r.kind).toBe('not_found');
  });

  it('多命中时拒绝猜测 —— 绝不返回第一个', () => {
    const r = bindStep(
      d({ role: 'button', name: 'Copy' }),
      table([
        { ref: 'e1', role: 'button', name: 'Copy' },
        { ref: 'e2', role: 'button', name: 'Copy' },
      ]),
    );
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.refs).toEqual(['e1', 'e2']);
  });

  it('scope 把多命中收敛为唯一', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', path: ['Payment methods'] },
      { ref: 'e2', role: 'button', name: 'Copy', path: ['Webhooks'] },
    ]);
    expect(matchCount(d({ role: 'button', name: 'Copy' }), t)).toBe(2);
    const r = bindStep(d({ role: 'button', name: 'Copy', scope: 'Webhooks' }), t);
    expect(r).toMatchObject({ kind: 'unique', ref: 'e2' });
  });

  it('nameMatch: contains / fuzzy', () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Create instance' }]);
    expect(bindStep(d({ role: 'button', name: 'Create' }), t).kind).toBe('not_found');
    expect(bindStep(d({ role: 'button', name: 'Create', nameMatch: 'contains' }), t).kind).toBe('unique');
  });

  it('显式 nth 匹配不到时是失败，而不是退回猜测', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Copy', nth: 1 },
      { ref: 'e2', role: 'button', name: 'Copy', nth: 2 },
    ]);
    expect(bindStep(d({ role: 'button', name: 'Copy', nth: 2 }), t)).toMatchObject({ kind: 'unique', ref: 'e2' });
    expect(bindStep(d({ role: 'button', name: 'Copy', nth: 9 }), t).kind).toBe('not_found');
  });

  it('role 不同不匹配', () => {
    const t = table([{ ref: 'e1', role: 'link', name: 'Save' }]);
    expect(bindStep(d({ role: 'button', name: 'Save' }), t).kind).toBe('not_found');
  });
});

describe('descriptorOf', () => {
  it('用最近的 path 段作为 scope', () => {
    const t = table([{ ref: 'e1', role: 'button', name: 'Stop', path: ['Instances', 'i-0abc'] }]);
    expect(descriptorOf(t.items[0]!)).toEqual({ role: 'button', name: 'Stop', scope: 'i-0abc' });
  });

  it('往返：生成的 descriptor 能唯一绑回原元素', () => {
    const t = table([
      { ref: 'e1', role: 'button', name: 'Stop', path: ['Instances', 'i-A'] },
      { ref: 'e2', role: 'button', name: 'Stop', path: ['Instances', 'i-B'] },
    ]);
    for (const item of t.items) {
      expect(bindStep(descriptorOf(item), t)).toMatchObject({ kind: 'unique', ref: item.ref });
    }
  });
});

describe('bind 的不猜测性质（K-6）', () => {
  it('无法区分的候选，2 个、3 个、5 个、14 个一律判为 ambiguous', () => {
    for (const n of [2, 3, 5, 14]) {
      const t = table(Array.from({ length: n }, (_, i) => ({ ref: `e${i}`, role: 'button', name: 'Copy' })));
      const r = bindStep(d({ role: 'button', name: 'Copy' }), t);
      expect(r.kind, `${n} 个候选`).toBe('ambiguous');
      if (r.kind === 'ambiguous') expect(r.refs, `${n} 个候选`).toHaveLength(n);
    }
  });
});
