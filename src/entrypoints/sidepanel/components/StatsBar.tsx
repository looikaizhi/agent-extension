import type { PromptTable } from '@/core/extractor/types';

export function StatsBar({ table }: { table: PromptTable }) {
  const s = table.stats;
  return (
    <div className="stats">
      <span title="进入投影表的控件数">
        控件 <b>{table.items.length}</b>
      </span>
      <span title="扫描的 DOM 元素总数">
        DOM <b>{s.elementsScanned}</b>
      </span>
      <span title="穿透的 open shadow root 数">
        Shadow <b>{s.shadowRoots}</b>
      </span>
      <span title="总耗时（遍历 / 可见性 / 语义）">
        耗时 <b>{s.ms.total}ms</b>
        <i>
          {' '}
          ({s.ms.walk}/{s.ms.visibility}/{s.ms.semantics})
        </i>
      </span>
      <span title="按 (path, role, name) 不唯一的控件比例">
        歧义 <b className={table.ambiguity > 5 ? 'warn' : ''}>{table.ambiguity}%</b>
      </span>
      {s.emptyName > 0 && (
        <span title="accessible name 为空的控件数">
          空名 <b>{s.emptyName}</b>
        </span>
      )}
      {s.modalScoped && <span className="badge">模态作用域</span>}
      {table.truncated && <span className="badge warn">已按预算裁剪</span>}
    </div>
  );
}
