import { describe, expect, it } from 'vitest';
import { NAME_MAX_LEN, budgetFor, project, toPromptYaml, truncate } from '@/core/extractor/project';
import type { LocatorView, UINode } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

const stats = {
  elementsScanned: 0,
  candidates: 0,
  visible: 0,
  emitted: 0,
  shadowRoots: 0,
  emptyName: 0,
  modalScoped: false,
  ms: { total: 1, walk: 0, visibility: 0, semantics: 0, name: 0 },
};

type NodeSpec = Omit<Partial<UINode>, 'ref'> & { ref: string; role: string; name: string };

function node(p: NodeSpec): UINode {
  return {
    ref: p.ref as unknown as Ref,
    role: p.role,
    name: p.name,
    rect: p.rect ?? [0, 10, 100, 20],
    inViewport: p.inViewport ?? true,
    frameId: 0,
    nameSource: 'content',
    ...(p.parent ? { parent: p.parent } : {}),
    ...(p.rowLabel ? { rowLabel: p.rowLabel } : {}),
    ...(p.sensitive ? { sensitive: true as const } : {}),
    ...(p.focusable ? { focusable: true as const } : {}),
  };
}

function view(nodes: UINode[]): LocatorView {
  return {
    snapshotId: 's1',
    url: 'https://example.test/x',
    title: 't',
    pageHash: 'h',
    profile: 'interactive',
    viewport: { width: 1280, height: 800 },
    nodes,
    degraded: false,
    stats,
  };
}

describe('budgetFor', () => {
  it.each([
    [15_999, 60],
    [16_000, 150],
    [64_000, 150],
    [64_001, 250],
  ])('contextWindow=%i → maxNodes=%i', (cw, expected) => {
    expect(budgetFor(cw).maxNodes).toBe(expected);
  });
});

describe('project', () => {
  const budget = { maxNodes: 150, viewportBands: 1 };

  it('只投影可交互角色', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'main', name: 'Main' }),
        node({ ref: 'e2', role: 'button', name: 'Go' }),
      ]),
      budget,
    );
    expect(t.items.map((i) => i.ref)).toEqual(['e2']);
  });

  it('path 由 landmark 与行标识组成', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'region', name: 'Instances' }),
        node({ ref: 'e2', role: 'button', name: 'Stop', parent: 'e1' as Ref, rowLabel: 'i-0abc' }),
      ]),
      budget,
    );
    expect(t.items[0]!.path).toEqual(['Instances', 'i-0abc']);
  });

  it('行标识区分同名按钮，歧义率为 0', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'region', name: 'Instances' }),
        node({ ref: 'e2', role: 'button', name: 'Stop', parent: 'e1' as Ref, rowLabel: 'i-A' }),
        node({ ref: 'e3', role: 'button', name: 'Stop', parent: 'e1' as Ref, rowLabel: 'i-B' }),
      ]),
      budget,
    );
    expect(t.ambiguity).toBe(0);
    expect(t.items.every((i) => i.nth === undefined)).toBe(true);
  });

  it('无法区分时才落到 nth，并如实报告歧义率', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'button', name: 'Copy' }),
        node({ ref: 'e2', role: 'button', name: 'Copy' }),
      ]),
      budget,
    );
    expect(t.items.map((i) => i.nth)).toEqual([1, 2]);
    expect(t.ambiguity).toBe(100);
  });

  it('超预算时保留主内容区、丢弃视口外的元素，并标记 truncated', () => {
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) =>
        node({ ref: `off${i}`, role: 'button', name: `Off ${i}`, inViewport: false }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        node({ ref: `in${i}`, role: 'button', name: `In ${i}`, inViewport: true }),
      ),
    ];
    const t = project(view(nodes), { ...budget, maxNodes: 5 });
    expect(t.truncated).toBe(true);
    expect(t.items.every((i) => i.ref.startsWith('in'))).toBe(true);
  });

  it('截断后仍按文档序输出', () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      node({ ref: `e${i}`, role: 'button', name: `B${i}`, inViewport: i % 2 === 0 }),
    );
    const t = project(view(nodes), { ...budget, maxNodes: 4 });
    const idx = t.items.map((i) => Number(i.ref.slice(1)));
    expect([...idx]).toEqual([...idx].sort((a, b) => a - b));
  });

  it('name 截断在中间，保留首尾', () => {
    // Middle truncation, because what distinguishes two long names is almost
    // always at the end — an ARN's resource id, a path's last segment.
    //
    // Tested against `truncate` rather than through a budget: the length is no
    // longer a per-caller knob (that was the drift bug), so there is nothing to
    // parameterise through `project` any more.
    const name = truncate(`START${'x'.repeat(200)}END`, 20);
    expect(name).toHaveLength(20);
    expect(name).toContain('…');
    expect(name.startsWith('START')).toBe(true);
    expect(name.endsWith('END')).toBe(true);
    expect(truncate('short', 20)).toBe('short');
  });

  it('截断长度对每个调用方都相同（身份不随预算漂移）', () => {
    // The regression: the host extracted at 120 and the side panel at 80, so
    // the same element got two identities and a descriptor authored against one
    // bound to nothing against the other.
    const long = `START${'x'.repeat(200)}END`;
    const at = (maxNodes: number) =>
      project(view([node({ ref: 'e1', role: 'button', name: long })]), { maxNodes, viewportBands: 1 })
        .items[0]!.name;
    expect(at(150)).toBe(at(100_000));
    expect(at(150)).toHaveLength(NAME_MAX_LEN);
    expect(budgetFor(8_000)).not.toHaveProperty('nameMaxLen');
  });

  it('可聚焦的 div 按钮也是目标（无 ARIA role 也算）', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'generic', name: 'Publish draft', focusable: true }),
        node({ ref: 'e2', role: 'generic', name: 'Just some text' }),
      ]),
      budget,
    );
    expect(t.items.map((i) => i.ref)).toEqual(['e1']);
  });

  it('敏感字段进表但被标记', () => {
    const t = project(
      view([node({ ref: 'e1', role: 'textbox', name: 'Password', sensitive: true })]),
      budget,
    );
    expect(t.items[0]!.sensitive).toBe(true);
  });
});

describe('path 取文档序前驱标题（F-9）', () => {
  const budget = { maxNodes: 150, viewportBands: 1 };

  it('标题是前驱兄弟而非祖先时也能进 path', () => {
    // The shape that broke it: `<h2>Webhooks</h2><button>Copy</button>` — the
    // heading is nowhere on the button's ancestor chain, so the old upward walk
    // returned nothing and both Copy buttons collapsed into one key.
    const t = project(
      view([
        node({ ref: 'h1', role: 'heading', name: 'Payment methods' }),
        node({ ref: 'e1', role: 'button', name: 'Copy' }),
        node({ ref: 'h2', role: 'heading', name: 'Webhooks' }),
        node({ ref: 'e2', role: 'button', name: 'Copy' }),
      ]),
      budget,
    );
    expect(t.items.map((i) => i.path)).toEqual([['Payment methods'], ['Webhooks']]);
    expect(t.ambiguity).toBe(0);
    expect(t.items.every((i) => i.nth === undefined)).toBe(true);
  });

  it('标题不会泄漏到另一个 landmark 里', () => {
    const t = project(
      view([
        node({ ref: 'nav', role: 'navigation', name: 'Sidebar' }),
        node({ ref: 'h1', role: 'heading', name: 'Filters', parent: 'nav' as Ref }),
        node({ ref: 'e1', role: 'button', name: 'Apply', parent: 'nav' as Ref }),
        node({ ref: 'main', role: 'main', name: 'Content' }),
        node({ ref: 'e2', role: 'button', name: 'Apply', parent: 'main' as Ref }),
      ]),
      budget,
    );
    // e2 must not inherit "Filters" just because it happens to come later.
    expect(t.items.map((i) => i.path)).toEqual([
      ['Sidebar', 'Filters'],
      ['Content'],
    ]);
  });

  it('landmark 与标题同名时不重复', () => {
    const t = project(
      view([
        node({ ref: 'r1', role: 'region', name: 'Webhooks' }),
        node({ ref: 'h1', role: 'heading', name: 'Webhooks', parent: 'r1' as Ref }),
        node({ ref: 'e1', role: 'button', name: 'Copy', parent: 'r1' as Ref }),
      ]),
      budget,
    );
    expect(t.items[0]!.path).toEqual(['Webhooks']);
  });

  it('标题在 landmark 之内时，两层都保留', () => {
    const t = project(
      view([
        node({ ref: 'r1', role: 'region', name: 'API keys' }),
        node({ ref: 'h1', role: 'heading', name: 'Restricted', parent: 'r1' as Ref }),
        node({ ref: 'e1', role: 'button', name: 'Reveal', parent: 'r1' as Ref }),
      ]),
      budget,
    );
    expect(t.items[0]!.path).toEqual(['API keys', 'Restricted']);
  });
});

describe('nth 在任意滚动位置可复现（F-5）', () => {
  const budget = { maxNodes: 150, viewportBands: 1 };

  /**
   * Three identical buttons spread down a long page; `at` simulates scrollY.
   *
   * `inViewport` is derived rather than defaulted: the helper's `?? true` made
   * every node claim to be on screen, so a fixture named "at scrollY=4500" did
   * not actually place anything off screen and the pruning it meant to exercise
   * never happened.
   */
  const pageAt = (scrollY: number) =>
    view(
      [100, 2600, 5100].map((top, i) => {
        const y = top - scrollY;
        return node({
          ref: `e${i + 1}`,
          role: 'button',
          name: 'Copy',
          rect: [0, y, 80, 24],
          inViewport: y + 24 > 0 && y < 800,
        });
      }),
    );

  it('同一元素在不同滚动位置拿到同一个 nth', () => {
    // The bug: `assignNth` ran after pruning, and pruning depends on scrollY, so
    // e2 was `nth: 2` from the top of the page and `nth: undefined` further
    // down. A descriptor authored at one position bound to nothing at another.
    const seen = new Map<string, Set<number | undefined>>();
    for (const scrollY of [0, 1000, 2000, 3500, 4500, 5000]) {
      for (const item of project(pageAt(scrollY), budget).items) {
        (seen.get(item.ref) ?? seen.set(item.ref, new Set()).get(item.ref)!).add(item.nth);
      }
    }
    expect([...seen.keys()].sort()).toEqual(['e1', 'e2', 'e3']);
    for (const [ref, values] of seen) expect([ref, [...values]]).toEqual([ref, [Number(ref[1])]]);
  });

  it('nth 反映整页，剪枝也改不了它', () => {
    // Squeeze the budget until only one item survives. Whoever survives is
    // still the *third* Copy on the page — reporting it as the first would make
    // the ordinal a lie, and a descriptor written from it would bind elsewhere.
    const table = project(pageAt(4500), { ...budget, maxNodes: 1 });
    expect(table.truncated).toBe(true);
    expect(table.items).toHaveLength(1);
    expect(table.items[0]!.nth).toBe(3);
  });

  it('预算够用时不因为「不在视口里」丢掉任何东西', () => {
    // The band used to filter before the budget cut, so information was thrown
    // away while budget was still available — which is why a control 1400px
    // down could not be found until the user scrolled to it.
    const table = project(pageAt(0), budget);
    expect(table.items.map((i) => i.ref)).toEqual(['e1', 'e2', 'e3']);
  });

  it('全页唯一的元素不会被强加 nth', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'button', name: 'Save', rect: [0, 10, 80, 24] }),
        node({ ref: 'e2', role: 'button', name: 'Delete', rect: [0, 40, 80, 24] }),
      ]),
      budget,
    );
    expect(t.items.every((i) => i.nth === undefined)).toBe(true);
  });
});

describe('toPromptYaml', () => {
  it('每组只写一次表头', () => {
    const t = project(
      view([
        node({ ref: 'e1', role: 'region', name: 'Instances' }),
        node({ ref: 'e2', role: 'button', name: 'Stop', parent: 'e1' as Ref }),
        node({ ref: 'e3', role: 'button', name: 'Start', parent: 'e1' as Ref }),
      ]),
      { maxNodes: 150, viewportBands: 1 },
    );
    const yaml = toPromptYaml(t);
    expect(yaml.match(/## Instances/g)).toHaveLength(1);
    expect(yaml).toContain('ref: e2');
    expect(yaml).toContain('ref: e3');
  });
});
