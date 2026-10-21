import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import type { ElementDescriptor } from '@/shared/protocol';
import { Icon } from '../ui/Icon';
import { describeRung } from '../view-model';
import { NodeTable } from './NodeTable';
import { PageBar } from './PageBar';

type Picked = { descriptor: ElementDescriptor; matches: number; correct: boolean; rung: string };
type Note = { kind: 'busy' | 'ok' | 'error'; text: string };

/**
 * 检视页面: what the extension sees on this tab — the whole table, or one
 * control picked by hand — and pointing at any of it.
 */
export function Inspect({
  tabId,
  onBack,
  onPointAt,
}: {
  tabId: number | null;
  onBack: () => void;
  /** Point at one control the user chose by hand — a fixed plan of one step.
   *  `stay` keeps the panel on this page rather than going back to the
   *  conversation. */
  onPointAt: (descriptor: ElementDescriptor, title: string, detail: string, stay?: boolean) => void;
}) {
  const [table, setTable] = useState<PromptTable | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** The table row last pointed at, lit on the page right now. */
  const [lit, setLit] = useState<string | null>(null);
  const inspectingRef = useRef(false);

  const inspect = useCallback(
    (on: boolean) => {
      if (tabId === null) return;
      inspectingRef.current = on;
      setInspecting(on);
      if (on) setPicked(null);
      void chrome.runtime.sendMessage({ type: 'PANEL_INSPECT', tabId, on });
    },
    [tabId],
  );

  // What was read belongs to the tab it was read on. Leaving this page, or the
  // tab, also takes inspect mode off that tab: nobody is left here to receive
  // the pick, and the page would go on swallowing clicks.
  useEffect(() => {
    setTable(null);
    setNote(null);
    setPicked(null);
    setLit(null);
    return () => {
      if (tabId === null || !inspectingRef.current) return;
      inspectingRef.current = false;
      setInspecting(false);
      void chrome.runtime.sendMessage({ type: 'PANEL_INSPECT', tabId, on: false });
    };
  }, [tabId]);

  // The inspector reports its pick as a content event, like every other thing
  // the page tells the extension.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const e = msg as (Picked & { type?: string }) | undefined;
      if (e?.type !== 'ELEMENT_PICKED') return;
      inspectingRef.current = false;
      setInspecting(false);
      setPicked({ descriptor: e.descriptor, matches: e.matches, correct: e.correct, rung: e.rung });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const extract = useCallback(async () => {
    if (tabId === null) return;
    setNote({ kind: 'busy', text: '正在抽取…' });
    const res = await chrome.runtime.sendMessage({ type: 'PANEL_EXTRACT', tabId });
    if (!res?.ok) return setNote({ kind: 'error', text: `抽取失败：${res?.message ?? '没有响应'}` });
    setTable(res.data);
    setLit(null);
    setNote(
      res.data.items.length === 0
        ? { kind: 'error', text: '本页面没有能识别的控件（可能是用 Canvas 画的）。' }
        : { kind: 'ok', text: `抽取到 ${res.data.items.length} 个控件` },
    );
  }, [tabId]);

  return (
    <div className="settings-page">
      <PageBar title="检视页面" parent="工具与设置" backLabel="返回工具与设置" onBack={onBack} />

      {/* 两个等宽的按钮，正在做的那件事是主按钮。检视中，它们和那句提示包在
          一张卡里——提示说的正是这两个按钮此刻的状态。 */}
      <div className={`inspect-tools${inspecting ? ' card' : ''}`}>
        <div className="pair">
          <button
            className={table && !inspecting ? 'primary' : ''}
            onClick={() => void extract()}
            disabled={note?.kind === 'busy'}
          >
            <Icon name={table ? 'refresh' : 'list'} weight={table ? 2.2 : 2} />
            {table ? '重新抽取' : '抽取本页元素'}
          </button>
          <button className={inspecting ? 'primary' : ''} aria-pressed={inspecting} onClick={() => inspect(!inspecting)}>
            <Icon name="crosshair" />
            {inspecting ? '取消检视' : '检视元素'}
          </button>
        </div>
        {inspecting && (
          <p className="callout">
            <span className="pulse" />
            <span>把鼠标移到页面上的控件，点击即选中。这一下点击不会传给页面。</span>
          </p>
        )}
      </div>

      {picked && (
        <section className={`card picked${picked.correct ? '' : ' ambiguous'}`}>
          <div className="picked-id">
            <span className="role">{picked.descriptor.role}</span>
            <span className="name">{picked.descriptor.name || '（无名称）'}</span>
          </div>
          <p className={`outcome ${picked.correct ? 'ok' : 'err'}`}>
            <Icon name={picked.correct ? 'check' : 'alert'} size={13} weight={picked.correct ? 2.8 : 2.2} />
            <span>
              {picked.correct
                ? `唯一命中 · ${describeRung(picked.rung)}`
                : `命中 ${picked.matches} 个——这个元素现在无法被唯一定位，照它引导可能指错。`}
            </span>
          </p>
          {picked.correct ? (
            <button className="primary" onClick={() => onPointAt(picked.descriptor, picked.descriptor.name || picked.descriptor.role, '（检视时选中）')}>
              <Icon name="pointer" size={13} />
              指给我
            </button>
          ) : (
            <button onClick={() => onPointAt(picked.descriptor, picked.descriptor.name || picked.descriptor.role, '（检视时选中）')}>
              仍然指给我
            </button>
          )}
        </section>
      )}

      {note?.kind === 'busy' && (
        <p className="callout busy">
          <span className="spinner" />
          <span>{note.text}</span>
        </p>
      )}
      {note?.kind === 'error' && (
        <p className="callout err">
          <Icon name="alert" />
          <span>{note.text}</span>
        </p>
      )}
      {table && note?.kind === 'ok' && <TableStats table={table} said={note.text} />}
      {table && table.items.length > 0 && (
        <NodeTable
          table={table}
          lit={lit}
          onPick={(ref) => {
            const item = table.items.find((i) => i.ref === ref);
            if (!item) return;
            // Pointed at from the table, the user stays at the table: the row
            // says it is the one lit on the page, and the next row is a click away.
            setLit(ref);
            onPointAt(descriptorOf(item), item.name || item.role, '（从元素表直接选中）', true);
          }}
        />
      )}
    </div>
  );
}

/** What one extraction saw and what it cost, as tiles. */
function TableStats({ table, said }: { table: PromptTable; said: string }) {
  const s = table.stats;
  return (
    <section className="card stats-card">
      <p className="note ok">
        <Icon name="check" size={13} weight={2.8} />
        {said}
      </p>
      <div className="tiles">
        <Tile label="控件" title="进入投影表的控件数" value={table.items.length} />
        <Tile label="扫描 DOM" title="扫描的 DOM 元素总数" value={s.elementsScanned.toLocaleString('en-US')} />
        <Tile label="Shadow" title="穿透的 open shadow root 数" value={s.shadowRoots} />
        <Tile
          label="耗时"
          title="总耗时（遍历 / 可见性 / 语义）"
          value={
            <>
              {s.ms.total}
              <small> ms</small>
            </>
          }
          sub={`${s.ms.walk} / ${s.ms.visibility} / ${s.ms.semantics}`}
        />
        <Tile label="歧义" title="按 (path, role, name) 不唯一的控件比例" value={`${table.ambiguity}%`} warn={table.ambiguity > 5} />
        <Tile label="空名" title="accessible name 为空的控件数" value={s.emptyName} warn={s.emptyName > 0} />
      </div>
      {(s.modalScoped || table.omitted > 0) && (
        <div className="chips">
          {s.modalScoped && <span className="chip">模态作用域</span>}
          {table.omitted > 0 && <span className="chip warn">已按预算裁剪 {table.omitted} 项</span>}
        </div>
      )}
    </section>
  );
}

function Tile({ label, title, value, sub, warn }: { label: string; title: string; value: ReactNode; sub?: string; warn?: boolean }) {
  return (
    <div className={`tile${warn ? ' warn' : ''}`} title={title}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
