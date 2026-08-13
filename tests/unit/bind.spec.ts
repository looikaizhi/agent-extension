import { describe, expect, it } from 'vitest';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import { bindStep, descriptorOf, matchCount } from '@/core/packs/bind';
import { rankCandidates } from '@/core/locator/lexical';
import type { ElementDescriptor } from '@/shared/protocol';
import type { Ref } from '@/shared/types';

type ItemSpec = Omit<Partial<PromptItem>, 'ref'> & { ref: string; role: string; name: string };

function table(items: ItemSpec[]): PromptTable {
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
  it.each([2, 3, 5, 14])('%i 个无法区分的候选一律判为 ambiguous', (n) => {
    const t = table(
      Array.from({ length: n }, (_, i) => ({ ref: `e${i}`, role: 'button', name: 'Copy' })),
    );
    const r = bindStep(d({ role: 'button', name: 'Copy' }), t);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.refs).toHaveLength(n);
  });
});

describe('rankCandidates —— K-6 也覆盖词法路径（任务 10）', () => {
  const items = (specs: Array<{ ref: string; name: string }>) =>
    table(specs.map((s) => ({ ref: s.ref, role: 'button', name: s.name }))).items;

  it('明确胜出时给唯一解', () => {
    const r = rankCandidates('create instance', items([
      { ref: 'e1', name: 'Create instance' },
      { ref: 'e2', name: 'Delete volume' },
    ]));
    expect(r).toMatchObject({ kind: 'unique' });
  });

  it('同名并列时不挑，而是全部返回', () => {
    // The exact shape the old `ranked[0]` silently resolved: identical names
    // score identically, so "first" meant "whichever the DOM order happened to
    // put first" — a silent mis-point with no signal anywhere.
    const r = rankCandidates('copy', items([
      { ref: 'e1', name: 'Copy' },
      { ref: 'e2', name: 'Copy' },
    ]));
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.items.map((i) => i.ref)).toEqual(['e1', 'e2']);
  });

  it('分差在阈值内的近似项也算并列', () => {
    const r = rankCandidates('copy', items([
      { ref: 'e1', name: 'Copy' },
      { ref: 'e2', name: 'Copy' },
      { ref: 'e3', name: 'Download everything as a zip archive' },
    ]));
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.items).toHaveLength(2);
  });

  it('完全没有匹配时给 none，而不是一个低分的第一名', () => {
    expect(rankCandidates('', items([{ ref: 'e1', name: 'Copy' }])).kind).toBe('none');
  });

  it('类型上就无法「从多个里挑一个」', () => {
    // There is no member of the union that carries both several candidates and
    // a chosen one, so the tie cannot be resolved by a caller at all.
    const r = rankCandidates('copy', items([
      { ref: 'e1', name: 'Copy' },
      { ref: 'e2', name: 'Copy' },
    ]));
    if (r.kind === 'ambiguous') expect('item' in r).toBe(false);
  });
});
