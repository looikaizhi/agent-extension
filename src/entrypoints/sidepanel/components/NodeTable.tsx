import type { ReactNode } from 'react';
import type { PromptTable } from '@/core/extractor/types';

/**
 * The node table is both the developer's view of "what the extension sees" and
 * the authoring surface for fixed plans — which is why U-10 (recording) could
 * be cut without losing the ability to write them.
 */
export function NodeTable({
  table,
  onPick,
}: {
  table: PromptTable;
  onPick: (ref: string) => void;
}) {
  let lastPath = ' ';
  const rows: ReactNode[] = [];

  for (const it of table.items) {
    const p = it.path.join(' › ');
    if (p !== lastPath) {
      lastPath = p;
      if (p)
        rows.push(
          <div className="group" key={`g-${it.ref}`}>
            {p}
          </div>,
        );
    }
    rows.push(
      <button
        className="node"
        key={it.ref}
        onClick={() => onPick(it.ref)}
        title={`${it.ref} · 点击高亮`}
      >
        <span className="role">{it.role}</span>
        <span className="name">{it.name || <i>（无名称）</i>}</span>
        {it.nth !== undefined && <span className="nth">#{it.nth}</span>}
        {it.state?.map((s) => (
          <span className="state" key={s}>
            {s}
          </span>
        ))}
        {it.sensitive && <span className="sensitive">敏感</span>}
      </button>,
    );
  }

  return (
    <section className="nodes">
      <h2>页面元素</h2>
      {rows.length ? rows : <p className="empty">没有可交互控件。</p>}
    </section>
  );
}
