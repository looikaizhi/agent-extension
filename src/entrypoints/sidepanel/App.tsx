import { useCallback, useEffect, useRef, useState } from 'react';
import { budgetFor } from '@/agent/budget';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/packs/bind';
import { packsFor } from '@/core/packs/match';
import { testConnection } from '@/agent/provider';
import { DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig, type ProviderConfig } from '@/shared/settings';
import {
  type ContentEvent,
  type GuideState,
  type GuideStep,
  type HighlightFailure,
  actionForRole,
} from '@/shared/protocol';
import { ensureInjected, onEvent, sendToTab } from '@/shared/rpc';
import { NodeTable } from './components/NodeTable';
import { StatsBar } from './components/StatsBar';

const CONTEXT_WINDOW = 32_000;

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

const FAILURE_TEXT: Record<HighlightFailure, string> = {
  snapshot_stale: '页面已变化，请重新抽取',
  ref_not_found: '找不到目标元素',
  sensitive_blocked: '目标是敏感输入框，已拒绝高亮',
  not_visible: '目标当前不可见',
  frame_unreachable: '目标在无法访问的 iframe 中',
};

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [table, setTable] = useState<PromptTable | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '就绪' });
  const [goal, setGoal] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [picked, setPicked] = useState<Extract<ContentEvent, { type: 'ELEMENT_PICKED' }> | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<Status>({ kind: 'idle', text: '尚未配置模型' });
  const abort = useRef<AbortController | null>(null);

  const pushLog = useCallback((s: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${s}`, ...l].slice(0, 40));
  }, []);

  useEffect(() => {
    const sync = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTabId(tab?.id ?? null);
      setUrl(tab?.url ?? '');
    };
    void sync();
    chrome.tabs.onActivated.addListener(sync);
    const onUpdated = (_id: number, info: { status?: string; url?: string }) => {
      if (info.status === 'complete' || info.url) void sync();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(sync);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const doExtract = useCallback(async (): Promise<PromptTable | null> => {
    if (tabId === null) return null;
    setStatus({ kind: 'busy', text: '正在抽取…' });
    if (!(await ensureInjected(tabId))) {
      setStatus({ kind: 'error', text: '本页面不允许扩展运行（或尚未授权该站点）' });
      return null;
    }
    const res = await sendToTab(tabId, {
      type: 'EXTRACT',
      profile: 'interactive',
      budget: budgetFor(CONTEXT_WINDOW),
    });
    if (!res.ok) {
      setStatus({ kind: 'error', text: `抽取失败：${res.message}` });
      return null;
    }
    setTable(res.data);
    if (res.data.items.length === 0) {
      setStatus({ kind: 'error', text: '本页面未提供可识别的控件（可能由 Canvas 绘制）' });
    } else {
      setStatus({ kind: 'ok', text: `抽取到 ${res.data.items.length} 个控件` });
    }
    return res.data;
  }, [tabId]);

  /**
   * The panel does not drive the guide; it asks the host to. The host is the
   * only process that survives both a navigation and this panel being closed,
   * so anything the panel remembered would be lost exactly when it mattered.
   */
  const startFlow = useCallback(
    async (steps: GuideStep[]) => {
      if (tabId === null || steps.length === 0) return;
      setStatus({ kind: 'busy', text: '正在定位…' });
      await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId, steps });
    },
    [tabId],
  );

  useEffect(() => {
    const listener = (msg: unknown) => {
      const a = msg as { type?: string; text?: string } | undefined;
      if (a?.type === 'AGENT_ANSWER' && a.text) setStatus({ kind: 'error', text: a.text });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(
    () =>
      onEvent((e: ContentEvent, from: number | null) => {
        // Events from a tab we are not looking at would otherwise be reported as
        // if they were ours — true the moment the user switches tabs mid-guide.
        if (from !== null && tabId !== null && from !== tabId) return;
        if (e.type === 'STEP_CONFIRMED') pushLog(`用户确认了第 ${e.stepIndex + 1} 步`);
        if (e.type === 'STEP_SKIPPED') pushLog(`跳过第 ${e.stepIndex + 1} 步`);
        if (e.type === 'TARGET_LOST') pushLog(`目标丢失 (${e.reason})：${e.ref}`);
        if (e.type === 'SESSION_ENDED') pushLog(`会话结束 (${e.reason})`);
        if (e.type === 'ELEMENT_PICKED') {
          setInspecting(false);
          setPicked(e);
          pushLog(`选中 ${e.label}（命中 ${e.matches}，${e.rung}）`);
        }
      }),
    [pushLog, tabId],
  );

  useEffect(() => {
    const listener = (msg: unknown) => {
      const g = msg as GuideState | undefined;
      if (g?.type !== 'GUIDE_STATE' || (tabId !== null && g.tabId !== tabId)) return;
      const at = `第 ${g.index + 1} / ${g.total} 步`;
      if (g.candidates) setStatus({ kind: 'error', text: `${at}匹配到 ${g.candidates} 个候选，已全部框出` });
      else if (g.failure) setStatus({ kind: 'error', text: `${at}未能渲染：${FAILURE_TEXT[g.failure]}` });
      else setStatus({ kind: 'ok', text: `已高亮${at}` });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId]);

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      if (c.apiKey || c.baseURL.includes('localhost'))
        setKeyState({ kind: 'idle', text: '已保存配置，未验证' });
    });
  }, []);

  const preset = PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[PRESETS.length - 1]!;

  const onTest = useCallback(async () => {
    setKeyState({ kind: 'busy', text: '正在测试连接…' });
    const r = await testConnection(cfg);
    setKeyState({ kind: r.ok ? 'ok' : 'error', text: r.message });
    if (r.ok) await saveConfig(cfg);
  }, [cfg]);

  const onAsk = useCallback(async () => {
    if (tabId === null) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setStatus({ kind: 'busy', text: '正在定位…' });
    // The panel does not resolve anything. It states the goal; the host runs the
    // agent, owns the thread, and reports back through GUIDE_STATE.
    await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId, goal });
  }, [tabId, goal]);

  const onRowClick = useCallback(
    async (ref: string) => {
      if (!table) return;
      const item = table.items.find((i) => i.ref === ref);
      if (!item) return;
      await startFlow([
        {
          ref: item.ref,
          descriptor: descriptorOf(item),
          expectedUserAction: actionForRole(item.role),
          title: item.name || item.role,
          detail: '（从元素表直接选中）',
        },
      ]);
    },
    [table, startFlow],
  );

  const availablePacks = url ? packsFor(url) : [];

  return (
    <div className="panel">
      <header>
        <h1>页面引导</h1>
        <p className="url" title={url}>
          {url || '（无活动标签页）'}
        </p>
      </header>

      <section className="ask">
        <input
          value={goal}
          placeholder="你想做什么？例如：克隆仓库"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goal.trim() && void onAsk()}
        />
        <div className="row">
          <button className="primary" disabled={!goal.trim()} onClick={() => void onAsk()}>
            引导我
          </button>
          <button onClick={() => void doExtract()}>抽取本页元素</button>
          <button
            onClick={() =>
              tabId !== null && void chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId })
            }
          >
            清除高亮
          </button>
          <button
            className={inspecting ? 'primary' : ''}
            onClick={() => {
              if (tabId === null) return;
              const on = !inspecting;
              setInspecting(on);
              if (on) setPicked(null);
              void sendToTab(tabId, { type: 'INSPECT', on });
            }}
          >
            {inspecting ? '取消检视' : '检视元素'}
          </button>
        </div>
        {availablePacks.length > 0 && (
          <p className="packs">
            本站可用引导包：{availablePacks.map((p) => p.displayName).join('、')}
          </p>
        )}
      </section>

      <p className={`status ${status.kind}`}>{status.text}</p>

      {inspecting && <p className="status busy">把鼠标移到页面上的控件，点击即选中（点击不会传给页面）</p>}

      {picked && (
        <section className="picked">
          <h2>{picked.label}</h2>
          <p className={`status ${picked.correct ? 'ok' : 'error'}`}>
            {picked.correct
              ? `唯一命中（${picked.rung}）`
              : `命中 ${picked.matches} 个 —— 这个 descriptor 现在就不安全，不要写进引导包`}
          </p>
          <pre>{picked.yaml}</pre>
        </section>
      )}

      {table && <StatsBar table={table} />}
      {table && <NodeTable table={table} onPick={(r) => void onRowClick(r)} />}

      <details className="settings">
        <summary>模型配置（BYOK）</summary>
        <p className="hint">
          Key 只存在本机的扩展存储里（不使用会同步到云端的 storage.sync），
          并且只会发往你在下面填写的端点。
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
        <p className={`status ${keyState.kind}`}>{keyState.text}</p>
      </details>

      {log.length > 0 && (
        <section className="log">
          <h2>事件</h2>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </section>
      )}
    </div>
  );
}
