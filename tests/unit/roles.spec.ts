import { roles } from 'aria-query';
import { describe, expect, it } from 'vitest';
import { PRIMARY_INTERACTIVE_ROLES } from '@/core/extractor/roles';

/**
 * aria-query is a devDependency only. Its `dom` map is unusable at runtime —
 * `@types/aria-query` declares `interactive?: boolean` but 5.3.2 ships only
 * `reserved`, so any check based on it fails silently. Here it is used purely
 * as a spec oracle: we get drift detection with zero runtime cost.
 */
describe('可交互 role 集合', () => {
  const widgetClosure = new Set<string>();
  for (const name of roles.keys()) {
    const def = roles.get(name);
    if (!def || def.abstract) continue;
    if (def.superClass.some((chain) => chain.includes('widget'))) widgetClosure.add(String(name));
  }

  /** Widget-subtree roles we deliberately do not point at. */
  const EXEMPT = new Set([
    'progressbar',
    'row',
    'grid',
    'tree',
    'treegrid',
    'radiogroup',
    'tablist',
    'scrollbar',
    'separator',
    'menubar',
    'menu',
    'toolbar',
    'listbox',
    'group',
    'tabpanel',
    'combobox',
    'listitem',
    'list',
    'table',
    'rowgroup',
    'caption',
    'cell',
    'columnheader',
    'rowheader',
    'gridcell',
    'option',
    'treeitem',
    'switch',
    'meter',
    'marquee',
    'timer',
    'tooltip',
    'application',
  ]);

  it('我们选中的 role 都在 ARIA widget 闭包内', () => {
    const outside = [...PRIMARY_INTERACTIVE_ROLES].filter((r) => !widgetClosure.has(r));
    expect(outside).toEqual([]);
  });

  it('规范新增的 widget role 必须被显式分类（收录或豁免）', () => {
    const unclassified = [...widgetClosure].filter(
      (r) => !PRIMARY_INTERACTIVE_ROLES.has(r) && !EXEMPT.has(r) && !r.startsWith('doc-'),
    );
    expect(unclassified).toEqual([]);
  });
});
