import { useCallback, useEffect, useState } from 'react';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { testConnection } from '@/agent/provider/provider';
import { DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig, type ProviderConfig } from '@/shared/settings';
import { actionForRole, type ElementDescriptor } from '@/shared/protocol';
import { NodeTable } from './components/NodeTable';
import { StatsBar } from './components/StatsBar';
import { summarizeCost, type CallRecord } from './view-model';

/**
 * Everything that is not the conversation, behind one disclosure: reading the
 * page's controls, picking one by hand, what the run has cost, and the model
 * configuration.
 *
 * These were the panel's main surface and are now its tool drawer — the
 * conversation is what the user came for, and these are what they open when
 * they want to look under it. Nothing was dropped in the move.
 */

type Picked = { descriptor: ElementDescriptor; label: string; matches: number; correct: boolean; rung: string };
type Note = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

export function Tools({
  tabId,
  costCalls,
  onPointAt,
}: {
  tabId: number | null;
  costCalls: readonly CallRecord[];
  /** Point at one control the user chose by hand — a fixed plan of one step. */
  onPointAt: (descriptor: ElementDescriptor, title: string, detail: string) => void;
}) {
  const [table, setTable] = useState<PromptTable | null>(null);
  const [note, setNote] = useState<Note>({ kind: 'idle', text: '' });
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<Note>({ kind: 'idle', text: '尚未配置模型' });

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      if (c.apiKey || c.baseURL.includes('localhost')) setKeyState({ kind: 'idle', text: '已保存配置，未验证' });
    });
  }, []);

  // The inspector reports its pick as a content event, like every other thing
  // the page tells the extension.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const e = msg as (Picked & { type?: string }) | undefined;
      if (e?.type !== 'ELEMENT_PICKED') return;
      setInspecting(false);
      setPicked({ descriptor: e.descriptor, label: e.label, matches: e.matches, correct: e.correct, rung: e.rung });
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
    setNote(
      res.data.items.length === 0
        ? { kind: 'error', text: '本页面未提供可识别的控件（可能由 Canvas 绘制）' }
        : { kind: 'ok', text: `抽取到 ${res.data.items.length} 个控件` },
    );
  }, [tabId]);

  const onTest = useCallback(async () => {
    setKeyState({ kind: 'busy', text: '正在测试连接…' });
    const r = await testConnection(cfg);
    setKeyState({ kind: r.ok ? 'ok' : 'error', text: r.message });
    if (r.ok) await saveConfig(cfg);
  }, [cfg]);

  const preset = PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[PRESETS.length - 1]!;
  const cost = summarizeCost(costCalls);

  return (
    <details className="tools">
      <summary>工具与设置</summary>

      <div className="row">
        <button onClick={() => void extract()}>抽取本页元素</button>
        <button
          className={inspecting ? 'primary' : ''}
          onClick={() => {
            if (tabId === null) return;
            const on = !inspecting;
            setInspecting(on);
            if (on) setPicked(null);
            void chrome.runtime.sendMessage({ type: 'PANEL_INSPECT', tabId, on });
          }}
        >
          {inspecting ? '取消检视' : '检视元素'}
        </button>
      </div>
      {inspecting && <p className="note busy">把鼠标移到页面上的控件，点击即选中（点击不会传给页面）</p>}
      {note.text && <p className={`note ${note.kind}`}>{note.text}</p>}

      {picked && (
        <section className="picked">
          <h3>{picked.label}</h3>
          <p className={`note ${picked.correct ? 'ok' : 'error'}`}>
            {picked.correct ? `唯一命中（${picked.rung}）` : `命中 ${picked.matches} 个 —— 这个元素现在无法被唯一定位，照它引导可能指错`}
          </p>
          <button className="primary" onClick={() => onPointAt(picked.descriptor, picked.descriptor.name || picked.descriptor.role, '（检视时选中）')}>
            指给我
          </button>
        </section>
      )}

      {cost.totalCalls > 0 && (
        <div className="stats cost">
          <span>
            调用 <b>{cost.totalCalls}</b>（主 {cost.primaryCalls} / 修复 {cost.repairCalls}）
          </span>
          <span>
            prompt <b>{cost.prompt}</b>
          </span>
          <span>
            completion <b>{cost.completion}</b>
          </span>
          <span>
            total <b>{cost.total}</b>
          </span>
          <span className={cost.estimated ? 'warn' : ''}>{cost.estimated ? '含估算值' : '真实用量'}</span>
          {cost.unknownCostCalls > 0 && <span className="warn">{cost.unknownCostCalls} 次调用未返回用量</span>}
        </div>
      )}

      {table && <StatsBar table={table} />}
      {table && (
        <NodeTable
          table={table}
          onPick={(ref) => {
            const item = table.items.find((i) => i.ref === ref);
            if (item) onPointAt(descriptorOf(item), item.name || item.role, '（从元素表直接选中）');
          }}
        />
      )}

      <details className="settings">
        <summary>模型配置（BYOK）</summary>
        <p className="hint">
          Key 只存在本机的扩展存储里（不使用会同步到云端的 storage.sync），并且只会发往你在下面填写的端点。
        </p>
        <label>
          厂商预设
          <select
            value={cfg.preset}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)!;
              setCfg({ ...cfg, preset: p.id, baseURL: p.baseURL, model: p.models[0] ?? cfg.model });
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {preset.note && <p className="hint warn">{preset.note}</p>}
        <label>
          端点
          <input value={cfg.baseURL} onChange={(e) => setCfg({ ...cfg, baseURL: e.target.value })} />
        </label>
        <label>
          模型
          <input value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
        </label>
        <label>
          上下文窗口（token）
          <input
            type="number"
            min={4_000}
            max={2_000_000}
            value={cfg.contextWindow}
            onChange={(e) => setCfg({ ...cfg, contextWindow: Number(e.target.value) })}
          />
        </label>
        <label>
          API Key
          <input
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={cfg.apiKey}
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
          />
        </label>
        <div className="row">
          <button className="primary" onClick={() => void onTest()}>
            测试连接并保存
          </button>
          <button onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'} Key</button>
        </div>
        <p className={`note ${keyState.kind}`}>{keyState.text}</p>
      </details>
    </details>
  );
}
