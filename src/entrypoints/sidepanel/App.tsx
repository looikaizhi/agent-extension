import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/packs/bind';
import { packsFor } from '@/core/packs/match';
import { complete, describeProviderError, testConnection } from '@/agent/provider';
import { parseContract } from '@/agent/plan/contract';
import { buildPrompt, buildRepairPrompt, ENVELOPE_SHAPE_GUIDE } from '@/agent/plan/prompt';
import { validateEnvelope } from '@/agent/plan/validate';
import { DEFAULT_CONFIG, loadConfig, PRESETS, saveConfig, type ProviderConfig } from '@/shared/settings';
import {
  type ContentEvent,
  type GuideClarify,
  type GuideCrossSite,
  type GuideState,
  type GuideStep,
  type HighlightFailure,
  actionForRole,
} from '@/shared/protocol';
import { onEvent } from '@/shared/rpc';
import type { GuideInflightResponse, WireBinding, WireCheck, WireEvidence } from '@/shared/protocol';
import type { GuideRouteHop } from '@/agent/plan/contract';
import { NodeTable } from './components/NodeTable';
import { StatsBar } from './components/StatsBar';
import { recoverInflightOnMount, startEffectListener } from './effects';
import {
  type CallRecord,
  type QaContext,
  describeAnswer,
  describeBinding,
  describeCheck,
  describeEvidence,
  sameQaContext,
  summarizeCost,
} from './qa';

/**
 * 05-route-and-steps.md's "账单前置": the model's latest coarse `route` plus
 * §5.7's three axes, shown next to whatever step is on screen — present only
 * while an S2 model-driven guide is running (`GuideState`'s optional fields
 * are absent for every S1 path, `App.tsx` never fabricates a placeholder for
 * them). Replaced wholesale on every `GUIDE_STATE` broadcast, never merged
 * with what was shown before (the Seam: "不做跨调用的路标拼接或去重").
 */
type GuideAxes = {
  route: readonly GuideRouteHop[];
  evidence: WireEvidence;
  check: WireCheck;
  binding: WireBinding;
  /** The model's own reason for the control on screen. */
  why?: string;
  /** Steps already walked, with how each turned out. */
  walked?: readonly { title: string; url: string; outcome: string; landedAt?: string }[];
  calls?: number;
};

const OUTCOME_LABEL: Record<string, string> = {
  confirmed: '已完成',
  invalidated: '目标消失',
  unknown: '进行中',
};

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; text: string };

/**
 * What "问这个页面" currently shows. Deliberately separate from `Status`
 * above (which belongs to the goal-guide input): the two inputs are two
 * different product capabilities, and conflating their
 * status lines would mean asking a question could stomp on a guide-in-
 * progress message, or vice versa.
 */
type QaViewState =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  // `highlightIssue` is set only when the *panel's own* page-identity check
  // (`sameQaContext`) passed but the host's later, narrower check (06/ADR
  // 0006 — it can only see `chrome.tabs.get`, not `snapshotId`) rejected the
  // highlight anyway, or the host could not reach the content script at
  // all. The answer text is still shown — the panel already trusts it —
  // this only says the highlight itself did not make it onto the page.
  | { kind: 'explain'; message: string; highlightIssue?: string }
  | { kind: 'clarify'; message: string; options: readonly { ref: string; label: string }[]; highlightIssue?: string }
  | { kind: 'need_text'; message: string }
  | { kind: 'error'; message: string };

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
  // 05-route-and-steps.md: `null` whenever no S2 model-driven guide is
  // currently reporting axes (no guide running, or an S1 pack/baseline/
  // inspector-driven one is) — see `GuideAxes`'s own doc comment.
  const [guideAxes, setGuideAxes] = useState<GuideAxes | null>(null);
  /** CL-1's question and its candidates, verbatim. `null` whenever the guide
   *  is not waiting on an answer. */
  const [guideClarify, setGuideClarify] = useState<{
    question: string;
    options: readonly { ref: string; label: string }[];
  } | null>(null);
  /** P-2: the next step leaves the site, and nothing is shown until the user
   *  answers. `null` whenever no such card is waiting. */
  const [crossSite, setCrossSite] = useState<{ from: string; to: string } | null>(null);
  const [picked, setPicked] = useState<Extract<ContentEvent, { type: 'ELEMENT_PICKED' }> | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showKey, setShowKey] = useState(false);
  const [keyState, setKeyState] = useState<Status>({ kind: 'idle', text: '尚未配置模型' });
  const abort = useRef<AbortController | null>(null);

  // ═══════════ "问这个页面" ═══════════
  const [question, setQuestion] = useState('');
  const [qaView, setQaView] = useState<QaViewState>({ kind: 'idle' });
  const [costCalls, setCostCalls] = useState<CallRecord[]>([]);
  /** One real `AbortController` per question, truly passed to `complete`
   *  (要害一). A new question, a tab switch, or the panel unmounting all
   *  abort whatever this currently points to — see `runQuestion`, `sync`
   *  below, and the unmount effect further down. */
  const qaAbort = useRef<AbortController | null>(null);
  /** Mirrors of the latest known tab/page state, updated the instant `sync`
   *  or `doExtract`/`runQuestion` learn something new. `runQuestion`'s own
   *  `tabId`/`url` closure params stay pinned to the values *when the
   *  question was asked* (ordinary JS closure semantics); these refs are
   *  what let it also see the *current* values once the model call returns,
   *  for the page-identity check (要害二). */
  const tabIdRef = useRef<number | null>(null);
  const urlRef = useRef('');
  const tableRef = useRef<PromptTable | null>(null);
  /** The tab a QA highlight is currently showing on, and whether that tab
   *  had a guide thread parked when we drew it. `null` when nothing is
   *  highlighted. Consumed by `endQaHighlight` to decide whether — and
   *  where — to call `PANEL_RESUME_GUIDE` (要害四). */
  const activeQaHighlight = useRef<{ tabId: number; guideActive: boolean } | null>(null);
  /** The exact text last submitted, for the error state's retry button —
   *  retrying re-runs `runQuestion` from scratch (a whole new call), it does
   *  not resume anything, so it needs the original question even if the
   *  input box has since been edited. */
  const lastQuestion = useRef('');

  const pushLog = useCallback((s: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()} ${s}`, ...l].slice(0, 40));
  }, []);

  /**
   * Ends whatever QA highlight is currently showing, and — only when that
   * highlight's tab had a guide thread parked (`guideActive`) — asks the
   * host to redraw it (`PANEL_RESUME_GUIDE`). No button drives this; it is
   * called at exactly the three moments 07 names: closing the answer,
   * starting a new question, and switching tabs (要害四).
   */
  const endQaHighlight = useCallback(async () => {
    const active = activeQaHighlight.current;
    activeQaHighlight.current = null;
    if (!active?.guideActive) return;
    await chrome.runtime.sendMessage({ type: 'PANEL_RESUME_GUIDE', tabId: active.tabId });
  }, []);

  useEffect(() => {
    const sync = async () => {
      // A different tab (or a navigation within this one) means the tab we
      // are leaving owns whatever question/highlight was in flight — both
      // end here, not later (要害一 / 要害四).
      qaAbort.current?.abort();
      void endQaHighlight();
      setQaView({ kind: 'idle' });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabIdRef.current = tab?.id ?? null;
      urlRef.current = tab?.url ?? '';
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
  }, [endQaHighlight]);

  // The panel unmounting (sidebar closed) is also an abort trigger (要害一)
  // — but not a `PANEL_RESUME_GUIDE` trigger: 07 names three explicit
  // moments for that (close answer / new question / switch tab), and
  // nobody is looking at this tab's overlay right now anyway.
  useEffect(() => () => qaAbort.current?.abort(), []);

  const doExtract = useCallback(async (): Promise<PromptTable | null> => {
    if (tabId === null) return null;
    setStatus({ kind: 'busy', text: '正在抽取…' });
    const res = await chrome.runtime.sendMessage({ type: 'PANEL_EXTRACT', tabId });
    if (!res.ok) {
      setStatus({ kind: 'error', text: `抽取失败：${res.message}` });
      return null;
    }
    tableRef.current = res.data;
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
      const c = msg as GuideClarify | undefined;
      if (c?.type !== 'GUIDE_CLARIFY' || (tabId !== null && c.tabId !== tabId)) return;
      setGuideClarify({ question: c.question, options: c.options });
      setStatus({ kind: 'ok', text: '引导需要你先说清楚一件事' });
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
      setGuideClarify(null);
      const at = `第 ${g.index + 1} / ${g.total} 步`;
      if (g.candidates) setStatus({ kind: 'error', text: `${at}匹配到 ${g.candidates} 个候选，已全部框出` });
      else if (g.failure) setStatus({ kind: 'error', text: `${at}未能渲染：${FAILURE_TEXT[g.failure]}` });
      else setStatus({ kind: 'ok', text: `已高亮${at}` });

      // Wholesale replace, never merge — the Seam's "展示的都是这次返回的
      //最新 route", and only ever present on an S2 model-driven broadcast.
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

  // 04-effect-protocol.md: the executor for whatever `EFFECT_REQUEST`s the
  // host broadcasts. Mounted once — `startEffectListener` itself decides,
  // per message, whether the tab it is currently tracking (`tabIdRef`) is
  // the one the request is for.
  useEffect(() => startEffectListener(() => tabIdRef.current, loadConfig), []);

  // E-6: pulled once per tab, never on a timer and never re-issuing an
  // `EffectRequest` of its own — a reopened panel only ever *reports* what
  // the host already knows.
  useEffect(() => {
    if (tabId === null) return;
    let cancelled = false;
    void recoverInflightOnMount(tabId, (id) =>
      chrome.runtime.sendMessage({ type: 'PANEL_GUIDE_INFLIGHT', tabId: id }) as Promise<GuideInflightResponse>,
    ).then(({ recovery }) => {
      if (cancelled) return;
      if (recovery === 'expired') pushLog('上一次模型调用已超时，未完成（如需重试，请重新发起）');
      else if (recovery === 'in_progress') pushLog('上一次模型调用仍在进行中，请稍候');
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
    abort.current?.abort();
    abort.current = new AbortController();
    setStatus({ kind: 'busy', text: '正在定位…' });
    // The panel does not resolve anything. It states the goal; the host runs the
    // agent, owns the thread, and reports back through GUIDE_STATE.
    await chrome.runtime.sendMessage({ type: 'START_GUIDE', tabId, goal });
  }, [tabId, goal]);

  /**
   * "问这个页面" — the seam 07-panel-loop.md names. A straight line, on
   * purpose: `PANEL_EXTRACT` → `buildPrompt` → the model call → `parseContract`
   * → (parse failure only) exactly one `buildRepairPrompt` + a second model
   * call → `parseContract` → `validateEnvelope` → render. No loop, no retry
   * counter — "1 主调用 + ≤1 修复" falls out of there being exactly two
   * literal calls to `complete` below, not out of anything that counts.
   *
   * Deliberately does NOT share a streaming helper between the primary and
   * repair calls: a reentrant function either of them could call from
   * inside itself is exactly the shape that turns into an unbounded retry
   * loop the moment someone edits it, even if today's two callers behave.
   * Two separate, literal call sites is what makes "at most one repair" a
   * structural fact instead of a promise (see 07-panel-loop.md's 完成判据).
   */
  const runQuestion = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (tabId === null || !q) return;
      lastQuestion.current = q;

      // Single-flight (要害一): a new question supersedes whatever the last
      // one was doing. Ends the previous highlight first, same as a tab
      // switch would — see `endQaHighlight`.
      qaAbort.current?.abort();
      void endQaHighlight();
      const controller = new AbortController();
      qaAbort.current = controller;

      setQaView({ kind: 'busy', message: '正在抽取页面元素…' });
      const extractRes = await chrome.runtime.sendMessage({ type: 'PANEL_EXTRACT', tabId });
      if (controller.signal.aborted) return; // superseded while extracting — say nothing
      if (!extractRes.ok) {
        setQaView({ kind: 'error', message: `抽取失败：${extractRes.message}` });
        return;
      }
      const snapshot: PromptTable = extractRes.data;
      tableRef.current = snapshot;
      setTable(snapshot);

      // What "the page" meant when this question was asked. `tabId`/`url`
      // here are this closure's own params — pinned to their values right
      // now by ordinary JS closure semantics — never the live `tabIdRef`/
      // `urlRef` a later render might update while we are still awaiting
      // below (要害二).
      const captured: QaContext = { tabId, url, snapshotId: snapshot.snapshotId };

      setQaView({ kind: 'busy', message: '正在询问模型…' });

      // ─── Primary call: the only place this question spends money before
      // knowing whether the output even parses. ───
      let primaryRaw = '';
      try {
        for await (const d of complete(cfg, buildPrompt(q, snapshot), controller.signal)) {
          // Progress indicator only (要害三): never render `d.content` itself.
          // Every `Delta` here is un-validated model output — it has not
          // been through `parseContract`/`validateEnvelope` yet, and may
          // never produce a legal envelope at all. Showing it verbatim
          // would hand the user half a JSON object or content R-a/R-e will
          // go on to reject. If you are here to "add back streaming
          // display", don't — that is the exact regression this comment
          // exists to stop; drive a "generating…" indicator off `.length`
          // (as below) or a timer instead, never off `.content`.
          primaryRaw += d.content;
          if (d.usage) setCostCalls((cs) => [...cs, { kind: 'primary', usage: d.usage! }]);
          else setQaView({ kind: 'busy', message: `正在生成回答…（已收到 ${primaryRaw.length} 字）` });
        }
      } catch (err) {
        if (controller.signal.aborted) return; // aborted mid-flight — not a real failure
        // The request went out even though it failed — it still counts
        // toward the cost panel (成本面板, "已发出但失败的调用照样计入").
        setCostCalls((cs) => [...cs, { kind: 'primary', usage: null }]);
        setQaView({ kind: 'error', message: describeProviderError(err) });
        return;
      }
      if (controller.signal.aborted) return;

      let parsed = parseContract(primaryRaw);
      let envelope = parsed.kind === 'ok' ? parsed.envelope : null;

      if (!envelope) {
        setQaView({ kind: 'busy', message: '首次输出无法解析，正在尝试一次修复…' });

        // ─── Repair call: the structurally-guaranteed *only* second
        // attempt (§5.9 of the agent design doc) — a brand-new minimal
        // conversation, never the original one with the bad output
        // appended, and never fed the page content a second time. There is
        // no third call site anywhere for this to loop into. ───
        let repairRaw = '';
        try {
          for await (const d of complete(cfg, buildRepairPrompt(primaryRaw, ENVELOPE_SHAPE_GUIDE), controller.signal)) {
            repairRaw += d.content; // same rule as the primary call: progress only, never displayed
            if (d.usage) setCostCalls((cs) => [...cs, { kind: 'repair', usage: d.usage! }]);
            else setQaView({ kind: 'busy', message: `正在修复…（已收到 ${repairRaw.length} 字）` });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          setCostCalls((cs) => [...cs, { kind: 'repair', usage: null }]); // same reasoning as the primary call above
          setQaView({ kind: 'error', message: describeProviderError(err) });
          return;
        }
        if (controller.signal.aborted) return;

        parsed = parseContract(repairRaw);
        if (parsed.kind === 'error') {
          setQaView({ kind: 'error', message: parsed.message });
          return;
        }
        envelope = parsed.envelope;
      }

      const validated = validateEnvelope(envelope, snapshot);
      if (validated.kind === 'violation') {
        setQaView({ kind: 'error', message: validated.reason });
        return;
      }

      // Page identity, re-checked against the *live* refs (要害二). This is
      // independent of — and in addition to — the URL check the host makes
      // before forwarding a highlight (06/ADR 0006): that one only decides
      // whether to paint an overlay; this one decides whether the panel
      // trusts the answer text enough to show it at all.
      const current: QaContext = {
        tabId: tabIdRef.current,
        url: urlRef.current,
        snapshotId: tableRef.current?.snapshotId ?? null,
      };
      if (!sameQaContext(captured, current)) {
        setQaView({ kind: 'error', message: '页面已经变化，这条回答可能不再适用，请重新提问。' });
        return;
      }

      // QA (ADR 0004) only ever prompts with `buildPrompt` (S1's three-intent
      // shape guide), so the model should never actually hand back `guide` /
      // `need_docs` here — those are S2's `AgentHost` path (`agent/api.ts`),
      // never QA's (see contract.ts's `KnownEnvelope` doc comment). But
      // `validateEnvelope`'s `ok.envelope` is now the full five-shape
      // `Envelope` (02-validate-guide.md widened it for `AgentHost`'s sake),
      // so this narrowing is what keeps that guarantee real instead of
      // assumed — a defensive `error`, not a silent cast, if it ever fires.
      if (
        validated.envelope.intent === 'guide' ||
        validated.envelope.intent === 'need_docs' ||
        validated.envelope.intent === 'done'
      ) {
        setQaView({ kind: 'error', message: `模型返回了问答流程不支持的信封类型「${validated.envelope.intent}」。` });
        return;
      }

      const answer = describeAnswer(validated.envelope, snapshot);
      setQaView(
        answer.intent === 'clarify'
          ? { kind: 'clarify', message: answer.message, options: answer.options ?? [] }
          : { kind: answer.intent, message: answer.message },
      );

      if (answer.items.length > 0) {
        const hl = await chrome.runtime.sendMessage({
          type: 'PANEL_SHOW_QA_RESULT',
          tabId,
          snapshotId: snapshot.snapshotId,
          url,
          items: answer.items,
          mode: 'explain',
          title: answer.intent === 'clarify' ? '需要你先选一个' : '依据',
        });
        if (controller.signal.aborted) return; // a newer question already owns the screen
        if (hl.ok) {
          activeQaHighlight.current = { tabId, guideActive: hl.data.guideActive };
        } else {
          // Our own `sameQaContext` check already passed above — this is the
          // narrower host-side rejection (a race in the small gap between
          // that check and this message arriving, or the content script
          // being unreachable). The answer text stays on screen; say so
          // honestly rather than pretending the highlight worked.
          activeQaHighlight.current = null;
          setQaView((v) =>
            v.kind === 'explain' || v.kind === 'clarify' ? { ...v, highlightIssue: hl.message } : v,
          );
        }
      }
    },
    [tabId, url, cfg, endQaHighlight],
  );

  const onAskQuestion = useCallback(() => void runQuestion(question), [question, runQuestion]);
  const cancelQuestion = useCallback(() => {
    qaAbort.current?.abort();
    setQaView({ kind: 'idle' });
  }, []);
  const closeQaAnswer = useCallback(() => {
    void endQaHighlight();
    setQaView({ kind: 'idle' });
  }, [endQaHighlight]);
  const retryQuestion = useCallback(() => void runQuestion(lastQuestion.current), [runQuestion]);

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
  const cost = summarizeCost(costCalls);

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
              void chrome.runtime.sendMessage({ type: 'PANEL_INSPECT', tabId, on });
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

      {/*
        05-route-and-steps.md："账单前置"——route 与三轴一到就展示，不是一个
        需要用户主动点开才看得到的东西，也不是一个要点确认才能继续的阻断式
        弹窗。只在 S2 模型驱动的引导正在报告时出现；route 里的字符串原样展
        示，不做任何二次加工（Gotchas）。三轴各自独立展示，互不覆盖。
      */}
      {/*
        CL-1：模型问回来一个澄清问题。候选全部列出、也全部在页面上框出，一个
        都不替用户选（K-6）。用户的回答方式就是把"引导我"那句话说得更具体再
        问一次——这里不放选项按钮，因为点一下就等于替他做了决定。
      */}
      {guideClarify && (
        <section className="clarify">
          <h2>需要你先说清楚</h2>
          <p>{guideClarify.question}</p>
          {guideClarify.options.length > 0 && (
            <ul className="qa-options">
              {guideClarify.options.map((o) => (
                <li key={o.ref}>{o.label}</li>
              ))}
            </ul>
          )}
          <p className="hint">把上面那句「引导我」说得更具体一点，再问一次。</p>
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
            <p className="why">
              <b>为什么是这一步：</b>
              {guideAxes.why}
            </p>
          )}
          {guideAxes.walked && guideAxes.walked.length > 0 && (
            <>
              <h3>已经走过</h3>
              <ol className="walked">
                {guideAxes.walked.map((w, i) => (
                  <li key={i}>
                    {w.title}
                    <i>（{OUTCOME_LABEL[w.outcome] ?? w.outcome}）</i>
                    {w.landedAt && <i> → {w.landedAt}</i>}
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="axes">
            <span title="Evidence">依据：{describeEvidence(guideAxes.evidence)}</span>
            <span title="Check">核验：{describeCheck(guideAxes.check)}</span>
            <span title="Binding">定位：{describeBinding(guideAxes.binding)}</span>
            {guideAxes.calls !== undefined && <span title="§5.10 上限 12 次">模型调用：{guideAxes.calls} / 12</span>}
          </div>
        </section>
      )}

      {/*
        独立的"问这个页面"入口 — 与上面的"引导我"分开摆
        放，不靠猜测用户打的字属于引导还是问答。问答是无状态的一次性回合
        （ADR 0004），不建 Thread、不动引导的游标。
      */}
      <section className="qa">
        <h2>问这个页面</h2>
        <input
          value={question}
          placeholder="例如：这个报错是什么意思？"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && question.trim() && onAskQuestion()}
        />
        <div className="row">
          <button className="primary" disabled={!question.trim() || qaView.kind === 'busy'} onClick={onAskQuestion}>
            问
          </button>
          {qaView.kind === 'busy' && <button onClick={cancelQuestion}>取消</button>}
        </div>

        {qaView.kind === 'busy' && <p className="status busy">{qaView.message}</p>}

        {(qaView.kind === 'explain' || qaView.kind === 'need_text') && (
          <div className="qa-answer">
            <p>{qaView.message}</p>
            {qaView.kind === 'explain' && qaView.highlightIssue && (
              <p className="status error">未能高亮依据元素：{qaView.highlightIssue}</p>
            )}
            <button onClick={closeQaAnswer}>关闭</button>
          </div>
        )}

        {qaView.kind === 'clarify' && (
          <div className="qa-answer">
            <p>{qaView.message}</p>
            {/* 所有候选一起列出、一起高亮——不替用户选一个（06 的 K-6 推论）。 */}
            <ul className="qa-options">
              {qaView.options.map((o) => (
                <li key={o.ref}>{o.label}</li>
              ))}
            </ul>
            {qaView.highlightIssue && <p className="status error">未能高亮候选元素：{qaView.highlightIssue}</p>}
            <button onClick={closeQaAnswer}>关闭</button>
          </div>
        )}

        {qaView.kind === 'error' && (
          <div className="qa-answer error">
            <p>{qaView.message}</p>
            {/* 契约违规 / 解析失败 / 网络错误统一落在这里；重试是用户按下
                按钮之后发生的全新一轮 runQuestion()，不是内部自动重试。 */}
            <div className="row">
              <button className="primary" onClick={retryQuestion}>
                重试
              </button>
              <button onClick={closeQaAnswer}>关闭</button>
            </div>
          </div>
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
