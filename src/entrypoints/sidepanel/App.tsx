import { useCallback, useEffect, useState } from 'react';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { testConnection } from '@/agent/provider/provider';
import { DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig, type ProviderConfig } from '@/shared/settings';
import {
  type ContentEvent,
  type ElementDescriptor,
  type GuideAsk,
  type GuideExplain,
  type GuideCrossSite,
  type GuideState,
  type GuideStep,
  type HighlightFailure,
  actionForRole,
} from '@/shared/protocol';
import { onEvent } from '@/shared/rpc';
import type { GuideInflightResponse, WireBinding, WireCheck, WireEvidence } from '@/shared/protocol';
import type { GuideRouteHop } from '@/shared/types';
import { NodeTable } from './components/NodeTable';
import { Prose } from './Prose';
import { StatsBar } from './components/StatsBar';
import { recoverInflightOnMount, startEffectListener } from './effects';
import { type CallRecord, describeBinding, describeCheck, describeEvidence, summarizeCost } from './view-model';

/**
 * "账单前置": the model's latest coarse `route` plus §5.7's three axes, shown
 * next to whatever step is on screen. Replaced wholesale on every
 * `GUIDE_STATE` broadcast, never merged with what was shown before (the Seam:
 * "不做跨调用的路标拼接或去重") — which is why the host sends all of it every
 * time.
 */
type GuideAxes = {
  route: readonly GuideRouteHop[];
  evidence: WireEvidence;
  check: WireCheck;
  binding: WireBinding;
  /** The model's own reason for the control on screen. */
  why?: string;
  /** Steps already walked, with how each turned out. */
  walked?: readonly WalkedStep[];
  calls?: number;
  spentSteps?: number;
};

type WalkedStep = NonNullable<GuideState['walked']>[number];

/** What the user reads beside each step already walked. A step taken on a page
 *  that did not change is said as exactly that — a copy button, or a link that
 *  opened a new tab, did its job without this page moving. */
const walkedLabel = (w: WalkedStep): string => {
  if (w.action === 'unavailable') return '为安全停下';
  if (w.action === 'skipped') return '跳过';
  if (w.action !== 'taken' || w.effect === undefined) return '进行中';
  if (w.effect.kind === 'unknown') return '点了，之后读不到这一页';
  return w.effect.kind === 'none' ? '点了，这一页没有变化' : '已完成';
};

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

const FAILURE_TEXT: Record<HighlightFailure, string> = {
  view_moved: '页面已经换了，这一步没有画出来',
  snapshot_stale: '页面已变化，请重新抽取',
  ref_not_found: '找不到目标元素',
  sensitive_blocked: '目标是敏感输入框，已拒绝高亮',
};

export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [table, setTable] = useState<PromptTable | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '就绪' });
  const [goal, setGoal] = useState('');
  const [log, setLog] = useState<string[]>([]);
  // `null` whenever no guide is currently reporting axes — see `GuideAxes`'s own doc comment.
  const [guideAxes, setGuideAxes] = useState<GuideAxes | null>(null);
  /** CL-1's question, what it wants back and its candidates, verbatim.
   *  `null` whenever the guide is not waiting on an answer. */
  const [guideAsk, setGuideAsk] = useState<Pick<GuideAsk, 'question' | 'wants' | 'options' | 'runGoesOn'> | null>(null);
  /** The guide agent's answer to a question about the page (`explain`). */
  const [guideExplain, setGuideExplain] = useState<string | null>(null);
  /** P-2: the next step leaves the site, and nothing is shown until the user
   *  answers. `null` whenever no such card is waiting. */
  const [crossSite, setCrossSite] = useState<{ from: string; to: string } | null>(null);
  const [picked, setPicked] = useState<Extract<ContentEvent, { type: 'ELEMENT_PICKED' }> | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<Status>({ kind: 'idle', text: '尚未配置模型' });

  /** Every model call this panel carried out, for the cost line. Kept in
   *  memory only: closing the panel starts it over. */
  const [costCalls, setCostCalls] = useState<CallRecord[]>([]);

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
    const res = await chrome.runtime.sendMessage({ type: 'PANEL_EXTRACT', tabId });
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
    async (goal: string, steps: GuideStep[]) => {
      if (tabId === null || steps.length === 0) return;
      setStatus({ kind: 'busy', text: '正在定位…' });
      await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId, goal, steps });
    },
    [tabId],
  );

  useEffect(() => {
    const listener = (msg: unknown) => {
      const a = msg as { type?: string; text?: string } | undefined;
      if (a?.type !== 'AGENT_ANSWER' || !a.text) return;
      setStatus({ kind: 'error', text: a.text });
      // Whatever the guide says next, a cross-site question it asked is no
      // longer waiting — it was answered on the overlay's card, or the run moved on.
      setCrossSite(null);
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
        if (e.type === 'STEP_USED') pushLog(e.how === 'typed' ? '用户在这一步里填了内容' : '用户点了这一步');
        if (e.type === 'STEP_SKIPPED') pushLog(`跳过第 ${e.stepIndex + 1} 步`);
        if (e.type === 'TARGET_LOST') pushLog(`目标丢失 (${e.reason})：${e.ref}`);
        if (e.type === 'SESSION_ENDED') {
          pushLog(`会话结束 (${e.reason})`);
          setGuideAxes(null);
        }
        if (e.type === 'ELEMENT_PICKED') {
          setInspecting(false);
          setPicked(e);
          pushLog(`选中 ${e.label}（命中 ${e.matches}，${e.rung}）`);
        }
      }),
    [pushLog, tabId],
  );

  // CL-1: the guide is parked on a question the model asked. Its own listener
  // and its own state, not folded into `GUIDE_STATE` above — there is no step
  // on screen to report an index for.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const c = msg as GuideAsk | undefined;
      if (c?.type !== 'GUIDE_ASK' || (tabId !== null && c.tabId !== tabId)) return;
      setGuideAsk({ question: c.question, wants: c.wants, options: c.options, runGoesOn: c.runGoesOn });
      setStatus({ kind: 'ok', text: '引导需要你先说清楚一件事' });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId]);

  // explain: the model answered a question about the page. What backs the
  // answer up is already outlined on the page by the host.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const c = msg as GuideExplain | undefined;
      if (c?.type !== 'GUIDE_EXPLAIN' || (tabId !== null && c.tabId !== tabId)) return;
      setGuideExplain(c.answer);
      setStatus({ kind: 'ok', text: '已回答' });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId]);

  // P-2: its own listener and its own state, same shape as CL-1's above —
  // there is no step on screen to report an index for, because not showing one
  // is the entire point until the user answers.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const c = msg as GuideCrossSite | undefined;
      if (c?.type !== 'GUIDE_CROSS_SITE' || (tabId !== null && c.tabId !== tabId)) return;
      setCrossSite({ from: c.from, to: c.to });
      setStatus({ kind: 'ok', text: '这一步会离开当前站点，需要你确认' });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId]);

  useEffect(() => {
    const listener = (msg: unknown) => {
      const g = msg as GuideState | undefined;
      if (g?.type !== 'GUIDE_STATE' || (tabId !== null && g.tabId !== tabId)) return;
      // A step reached the screen, so any cross-site card that was blocking it
      // has been answered — clear it rather than leaving a stale ask up.
      setCrossSite(null);
      // A step is on screen again, so the question that was blocking is
      // answered — clear it rather than stacking two competing asks.
      setGuideAsk(null);
      setGuideExplain(null);
      const at = g.total === null ? `第 ${g.index + 1} 步` : `第 ${g.index + 1} / ${g.total} 步`;
      if (g.candidates) setStatus({ kind: 'error', text: `${at}匹配到 ${g.candidates} 个候选，已全部框出` });
      else if (g.failure) setStatus({ kind: 'error', text: `${at}未能渲染：${FAILURE_TEXT[g.failure]}` });
      else setStatus({ kind: 'ok', text: `已高亮${at}` });

      // Wholesale replace, never merge — the Seam's "展示的都是这次返回的
      // 最新 route".
      setGuideAxes(
        g.route !== undefined && g.evidence !== undefined && g.check !== undefined && g.binding !== undefined
          ? {
              route: g.route,
              evidence: g.evidence,
              check: g.check,
              binding: g.binding,
              ...(g.why !== undefined ? { why: g.why } : {}),
              ...(g.walked !== undefined ? { walked: g.walked } : {}),
              ...(g.calls !== undefined ? { calls: g.calls } : {}),
              ...(g.spentSteps !== undefined ? { spentSteps: g.spentSteps } : {}),
            }
          : null,
      );
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

  // The effect protocol (design doc §2.6): the executor for whatever `EFFECT_REQUEST`s the
  // host broadcasts. Mounted once, and it answers every tab's requests, not
  // only the tab this panel is showing — see `startEffectListener`.
  useEffect(
    () =>
      startEffectListener(loadConfig, ({ providerCalls, usage }) =>
        setCostCalls((cs) => [
          ...cs,
          // The endpoint reports one figure for the whole effect, because the
          // repair round runs inside the runner. It goes on the first record;
          // the rest say `merged` so they are counted without pretending their
          // usage went missing.
          { kind: 'primary', usage: usage ? { ...usage, estimated: false } : null },
          ...Array.from({ length: Math.max(0, providerCalls - 1) }, () => ({ kind: 'repair' as const, usage: 'merged' as const })),
        ]),
      ),
    [],
  );

  // E-6: pulled once per tab, never on a timer and never re-issuing an
  // `EffectRequest` of its own — a reopened panel only ever *reports* what
  // the host already knows. A call that expired is not reported here: the
  // host sweeps it while answering and tells every panel itself.
  useEffect(() => {
    if (tabId === null) return;
    let cancelled = false;
    void recoverInflightOnMount(tabId, (id) =>
      chrome.runtime.sendMessage({ type: 'PANEL_GUIDE_INFLIGHT', tabId: id }) as Promise<GuideInflightResponse>,
    ).then(({ recovery }) => {
      if (cancelled) return;
      if (recovery === 'in_progress') pushLog('上一次模型调用仍在进行中，请稍候');
    });
    return () => {
      cancelled = true;
    };
  }, [tabId, pushLog]);

  const preset = PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[PRESETS.length - 1]!;

  const onTest = useCallback(async () => {
    setKeyState({ kind: 'busy', text: '正在测试连接…' });
    const r = await testConnection(cfg);
    setKeyState({ kind: r.ok ? 'ok' : 'error', text: r.message });
    if (r.ok) await saveConfig(cfg);
  }, [cfg]);

  const onAsk = useCallback(async () => {
    if (tabId === null) return;
    setGuideExplain(null);
    setStatus({ kind: 'busy', text: '正在想…' });
    // The panel does not resolve anything. It states the goal; the host runs the
    // agent, owns the thread, and reports back through GUIDE_STATE.
    await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId, goal });
  }, [tabId, goal]);

  /**
   * One element, pointed at as a one-step fixed plan — a row of the element
   * table, or what the inspector picked. No `ref`: a ref belongs to the
   * snapshot it came from, and the host takes a fresh one before painting.
   * The descriptor is what survives.
   */
  const pointAt = useCallback(
    async (descriptor: ElementDescriptor, detail: string) => {
      const title = descriptor.name || descriptor.role;
      await startFlow(`定位「${title}」`, [
        { descriptor, expectedUserAction: actionForRole(descriptor.role), title, detail },
      ]);
    },
    [startFlow],
  );

  const onRowClick = useCallback(
    async (ref: string) => {
      const item = table?.items.find((i) => i.ref === ref);
      if (item) await pointAt(descriptorOf(item), '（从元素表直接选中）');
    },
    [table, pointAt],
  );

  const cost = summarizeCost(costCalls);

  return (
    <div className="panel">
      <header>
        <h1>页面引导</h1>
        <p className="url" title={url}>
          {url || '（无活动标签页）'}
        </p>
      </header>

      {/*
        唯一的入口（08b）。用户只说一句话：想做成什么，或者想问这一页什么——
        不在这里分流，模型按行为决定（CONTEXT.md `Question`）。引导进行中再说
        的话交给那一趟引导（宿主的 `START_GUIDE`）。
      */}
      <section className="ask">
        <input
          value={goal}
          placeholder="想做什么，或者想问这一页什么？例如：克隆仓库"
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goal.trim() && void onAsk()}
        />
        <div className="row">
          <button className="primary" disabled={!goal.trim()} onClick={() => void onAsk()}>
            发送
          </button>
          <button onClick={() => void doExtract()}>抽取本页元素</button>
          <button
            onClick={() =>
              tabId !== null && void chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId })
            }
          >
            结束引导
          </button>
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
      </section>

      {/*
        "账单前置"——route 与三轴一到就展示，不是一个
        需要用户主动点开才看得到的东西，也不是一个要点确认才能继续的阻断式
        弹窗。route 里的字符串原样展示，不做任何二次加工（Gotchas）。三轴各自
        独立展示，互不覆盖。
      */}
      {/*
        模型问回来一句（ask）。要选一个时，候选全部列出、也全部在页面上框出，
        一个都不替用户选（K-6）。用户在上面的输入框里回答：引导还在走就直接交给
        它，问答那一趟已经收场就连同要做的事再说一次。这里不放选项按钮，因为
        点一下就等于替他做了决定。
      */}
      {guideAsk && (
        <section className="ask-card">
          <h2>需要你先说清楚</h2>
          <Prose text={guideAsk.question} />
          {guideAsk.options.length > 0 && (
            <ul className="options">
              {guideAsk.options.map((o) => (
                <li key={o.ref}>{o.label}</li>
              ))}
            </ul>
          )}
          <p className="hint">
            {guideAsk.runGoesOn
              ? '直接在上面的输入框里回答它。'
              : '把回答连同你要做的事一起，在上面的输入框里再说一次。'}
            {guideAsk.wants === 'text' && '密码、验证码、卡号不要写进来——那些只在页面上自己填。'}
          </p>
        </section>
      )}

      {/*
        explain：模型回答了关于这一页的问题。依据已经由宿主在页面上框出来；
        关掉回答时，如果还有一趟引导在走，就把它那一步重新画回来。
      */}
      {guideExplain && (
        <section className="answer-card">
          <h2>回答</h2>
          <Prose text={guideExplain} />
          <button
            onClick={async () => {
              setGuideExplain(null);
              if (tabId === null) return;
              // A guide still going gets its step painted back; with none, the
              // outline of what backed the answer comes down.
              const resumed = await chrome.runtime.sendMessage({ type: 'PANEL_RESUME_GUIDE', tabId });
              if (!resumed?.ok) await chrome.runtime.sendMessage({ type: 'END_GUIDE', tabId });
            }}
          >
            关闭
          </button>
        </section>
      )}

      {/*
        P-2：这一步会离开当前站点。卡片念的是**完整 hostname**，不是品牌名或
        站点展示名——本阶段没有主体提取，我们只说自己观察得到的字面地址，不做
        「这是谁」这类无法证实的断言（设计文档 §8.4 结尾的能力边界）。

        与 CL-1 不同，这里放按钮：那是一道确认，不是替用户做决定。
      */}
      {crossSite && (
        <section className="cross-site">
          <h2>这一步会离开当前站点</h2>
          <p>
            你正要从 <code>{crossSite.from}</code> 前往 <code>{crossSite.to}</code>。
          </p>
          <div className="row">
            <button
              onClick={() => {
                setCrossSite(null);
                void chrome.runtime.sendMessage({ type: 'CROSS_SITE_DECISION', tabId, confirmed: true });
              }}
            >
              继续，带我去
            </button>
            <button
              onClick={() => {
                setCrossSite(null);
                void chrome.runtime.sendMessage({ type: 'CROSS_SITE_DECISION', tabId, confirmed: false });
              }}
            >
              先不去
            </button>
          </div>
        </section>
      )}

      {guideAxes && (
        <section className="route">
          <h2>整体路标</h2>
          <ol className="route-hops">
            {guideAxes.route.map((hop, i) => (
              <li key={i}>
                <b>{hop.at}</b>：{hop.goal}
              </li>
            ))}
          </ol>
          {/* 让判断过程可见：模型为什么挑了这个控件、已经走过哪几步、
              各自的结果、到目前为止花了几次调用。这些数据本来就在线程里，
              只是以前只有模型读得到。 */}
          {guideAxes.why && (
            <div className="why">
              <b>为什么是这一步：</b>
              <Prose text={guideAxes.why} />
            </div>
          )}
          {guideAxes.walked && guideAxes.walked.length > 0 && (
            <>
              <h3>已经走过</h3>
              <ol className="walked">
                {guideAxes.walked.map((w, i) => (
                  <li key={i}>
                    {w.title}
                    <i>（{walkedLabel(w)}）</i>
                    {w.effect?.kind === 'moved' && <i> → {w.effect.to}</i>}
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="axes">
            <span title="Evidence">依据：{describeEvidence(guideAxes.evidence)}</span>
            <span title="Check">核验：{describeCheck(guideAxes.check)}</span>
            <span title="Binding">定位：{describeBinding(guideAxes.binding)}</span>
            {guideAxes.spentSteps !== undefined && <span title="一趟最多 12 步">步数：{guideAxes.spentSteps} / 12</span>}
            {guideAxes.calls !== undefined && <span title="这一趟一共问了模型几次">模型调用：{guideAxes.calls}</span>}
          </div>
        </section>
      )}

      {costCalls.length > 0 && (
        <div className="stats cost" title="内存态，不落盘——关闭面板或重开标签页会清零">
          <span>
            调用 <b>{cost.totalCalls}</b>
            <i>
              {' '}
              (主 {cost.primaryCalls} / 修复 {cost.repairCalls})
            </i>
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
          {cost.unknownCostCalls > 0 && (
            <span className="warn">{cost.unknownCostCalls} 次调用未返回用量</span>
          )}
        </div>
      )}

      <div className={`status ${status.kind}`}>
        <Prose text={status.text} />
      </div>

      {inspecting && <p className="status busy">把鼠标移到页面上的控件，点击即选中（点击不会传给页面）</p>}

      {picked && (
        <section className="picked">
          <h2>{picked.label}</h2>
          <p className={`status ${picked.correct ? 'ok' : 'error'}`}>
            {picked.correct
              ? `唯一命中（${picked.rung}）`
              : `命中 ${picked.matches} 个 —— 这个元素现在无法被唯一定位，照它引导可能指错`}
          </p>
          {/* 照选中时写出的 descriptor 指一步；命中不止一个时，候选全部框出、不替用户挑。 */}
          <button className="primary" onClick={() => void pointAt(picked.descriptor, '（检视时选中）')}>
            指给我
          </button>
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
