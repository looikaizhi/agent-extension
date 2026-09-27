import { useCallback, useEffect, useState } from 'react';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { disableThinkingAndVerify, listModels, verifyModel } from '@/agent/provider/provider';
import { modelIsConfigured } from '@/agent/provider/call';
import {
  DEFAULT_CONFIG,
  loadConfig,
  PRESETS,
  presetRequestByModel,
  requestFieldsFor,
  saveConfig,
  verdictFor,
  withRequestFields,
  withVerdict,
  type ForcedToolChoice,
  type ProtocolId,
  type ProviderConfig,
} from '@/shared/settings';
import { PROTOCOLS } from '@/agent/provider/protocols';
import { actionForRole, type ElementDescriptor } from '@/shared/protocol';
import { NodeTable } from './components/NodeTable';
import { StatsBar } from './components/StatsBar';
import type { WalkedPath } from '@/agent/context/memory';
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

/**
 * What the stored switch says, in one line — read off the *saved* value, so
 * closing the panel does not erase it.
 *
 * It used to be transient component state: a verdict was written to storage,
 * refused every call from then on (`guide/runner.ts`), and left no trace on
 * screen and no way back. A measurement the product acts on has to be visible
 * where it was made.
 */
const FORCED_TOOL_CHOICE_NOTE: Record<ForcedToolChoice, string> = {
  unknown: '「必须调用工具」这一条还没在这个模型上验收过——引导照常会试。',
  supported: '已实测：这个模型认「必须调用工具」。',
  unsupported:
    '已实测：这个模型忽略「必须调用工具」。引导的每一步都要靠它，所以它的每一次调用都会被提前拦下——在这个端点上换一个模型，或者按下面那个出口。',
};

/**
 * The mark a candidate carries in the list.
 *
 * This is the answer to "424 个模型里我该选哪个", and it is deliberately not a
 * recommendation: the only models marked are the ones *this user* verified on
 * *this* endpoint. Nothing is predicted, and a model nobody has tried carries
 * no mark at all rather than a reassuring blank verdict.
 */
const VERDICT_MARK: Record<ForcedToolChoice, string> = {
  unknown: '',
  supported: '✅ 验收过',
  unsupported: '⚠️ 跑不动',
};

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
  /** What this endpoint answered when asked what it has. `null` is "nobody has
   *  asked yet", which is not the same as "it has none" — and it goes back to
   *  `null` the moment the address or the key changes. */
  const [models, setModels] = useState<string[] | null>(null);
  /** Which kind of "no" the last verification was, when it was one the user
   *  can act on. Two of the three put the same button on screen — the one
   *  that measures whether thinking was the reason. */
  const [wall, setWall] = useState<'thinking' | 'refused' | 'busy' | null>(null);
  /** The extra-fields box, as text. Kept apart from the configuration so that
   *  a half-typed `{"enable_thinking":` is something the user can keep typing
   *  rather than something that gets written down and sent. */
  const [fieldsText, setFieldsText] = useState('');
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  /** The box always shows what will actually be sent with *this* model. */
  const showFields = useCallback((c: ProviderConfig) => {
    const f = requestFieldsFor(c);
    setFieldsText(Object.keys(f).length ? JSON.stringify(f) : '');
    setFieldsError(null);
  }, []);

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      showFields(c);
      // `modelIsConfigured` rather than a substring test for "localhost": the
      // same rule the host asks before starting a run, so the panel cannot say
      // "configured" about something the host will refuse (`call.ts`).
      if (modelIsConfigured(c)) setKeyState({ kind: 'idle', text: `已保存配置：${c.model || '（还没选模型）'}` });
    });
  }, [showFields]);

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

  /**
   * Switching what the form points at. Verdicts are *kept*, because they are
   * filed under the model they were measured on — picking another model and
   * coming back is the case this whole per-model table exists for.
   */
  const point = useCallback(
    (patch: Partial<ProviderConfig>): ProviderConfig => {
      const next = { ...cfg, ...patch };
      setCfg(next);
      setWall(null);
      return next;
    },
    [cfg],
  );

  /** A new address, a new key or another wire: nothing in the table was
   *  measured *there*, so every verdict goes, and so do the candidates — those
   *  names came from one endpoint answering one key. The request fields stay;
   *  they are input, not measurement (`settings.ts`). */
  const repoint = useCallback(
    (patch: Partial<ProviderConfig>) => {
      showFields(point({ ...patch, verdictByModel: {} }));
      setModels(null);
    },
    [point, showFields],
  );

  /**
   * Editing the box by hand. The text is kept as typed and only reaches the
   * configuration once it parses into an object — so an unfinished `{"a":`
   * stops at a note rather than going out with the next request. Emptying the
   * box removes this model's entry rather than storing `{}`.
   */
  const editFields = useCallback(
    (text: string) => {
      setFieldsText(text);
      if (!text.trim()) {
        setFieldsError(null);
        // The entry goes away rather than becoming an empty object, and this
        // model's verdict goes with it: it was measured with those fields.
        const { [cfg.model]: _gone, ...rest } = cfg.requestByModel;
        const { [cfg.model]: _stale, ...verdicts } = cfg.verdictByModel;
        point({ requestByModel: rest, verdictByModel: verdicts });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setFieldsError('这段 JSON 还不完整，暂时没有写进配置。');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return setFieldsError('要是一个 JSON 对象，例如 {"enable_thinking": false}');
      setFieldsError(null);
      point(withRequestFields(cfg, parsed as Record<string, unknown>));
    },
    [cfg, point],
  );

  /** Step 1: address + key, and the endpoint says what it has. */
  const onConnect = useCallback(async () => {
    setKeyState({ kind: 'busy', text: '正在连接…' });
    const r = await listModels(cfg);
    // No green for an endpoint that answered without a listing: it did not
    // fail, but nothing about it has been confirmed yet either.
    setKeyState({ kind: r.ok ? (r.models.length ? 'ok' : 'idle') : 'error', text: r.message });
    setModels(r.ok ? r.models : null);
    // An address and a key that got this far are worth keeping even if the
    // user stops here — what is *not* written is any claim about the model.
    if (r.ok) await saveConfig(cfg);
  }, [cfg]);

  /** Step 2: one real call with the model that was chosen — and the only
   *  place the chosen model gets written down. */
  const onVerify = useCallback(async () => {
    setKeyState({ kind: 'busy', text: `正在用「${cfg.model}」做一次最小真调用…` });
    const r = await verifyModel(cfg);
    setKeyState({ kind: r.ok ? 'ok' : 'error', text: r.message });
    setWall(r.wall ?? null);
    // What the probe learned is stored whether or not the verdict was good:
    // an endpoint measured as ignoring forced tool calls is refused before the
    // next request goes out (`guide/runner.ts`), which is the whole point of
    // asking. A run that learned nothing writes `unknown` — the same as never
    // having asked, which is the truth.
    // A missing address or a missing model means the call never left; nothing
    // was learned and nothing is worth storing, least of all an address the
    // next panel would load back in.
    if (!r.forcedToolChoice) return;
    const next = withVerdict(cfg, r.forcedToolChoice);
    setCfg(next);
    await saveConfig(next);
  }, [cfg]);

  /**
   * 「关掉思考，再试一次」. The user does not know what a thinking mode is, and
   * should not have to learn which of two vendors' spellings this endpoint
   * accepts — so the button finds out and reports which one it was.
   */
  const onDisableThinking = useCallback(async () => {
    setKeyState({ kind: 'busy', text: '正在试这个端点认哪种写法…' });
    const r = await disableThinkingAndVerify(cfg);
    setKeyState({ kind: r.ok ? 'ok' : 'error', text: r.message });
    setWall(null);
    // Nothing measured, nothing written — the configuration is left exactly as
    // the user had it rather than carrying a field that never worked.
    if (!r.fields) return;
    const fixed = withRequestFields(cfg, r.fields);
    const next = r.forcedToolChoice ? withVerdict(fixed, r.forcedToolChoice) : fixed;
    setCfg(next);
    showFields(next);
    await saveConfig(next);
  }, [cfg, showFields]);

  /** The way back out of a verdict. The switch's default is "not asked yet,
   *  send anyway"; when the probe answers wrongly — a one-off 500, a model
   *  that needed a field this endpoint's preset does not carry — the user gets
   *  the same right the default has. */
  const onOverride = useCallback(async () => {
    const next = withVerdict(cfg, 'unknown');
    setCfg(next);
    await saveConfig(next);
    setKeyState({ kind: 'idle', text: '已按「未知」保存：引导会照常发出「必须调用工具」。' });
  }, [cfg]);

  // 它记住的路：本来就写在 Run record 里，这里只是让用户看得见、也拿得回去。
  const [walked, setWalked] = useState<WalkedPath[] | null>(null);
  const loadMemory = useCallback(async () => {
    const r = (await chrome.runtime.sendMessage({ type: 'GET_MEMORY' })) as { paths?: WalkedPath[] } | undefined;
    setWalked(r?.paths ?? []);
  }, []);
  const forget = useCallback(
    async (runId?: string) => {
      await chrome.runtime.sendMessage({ type: 'FORGET_MEMORY', ...(runId ? { runId } : {}) });
      await loadMemory();
    },
    [loadMemory],
  );

  const preset = PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[PRESETS.length - 1]!;
  /** Verified models, the ones that work first — `unknown` is not a
   *  measurement and has nothing to show. */
  const measured = (Object.entries(cfg.verdictByModel) as [string, ForcedToolChoice][])
    .filter(([, v]) => v !== 'unknown')
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'supported' ? -1 : 1));
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
        {/* 预设不再是模型名的来源——名字会过期，2026-09-25 核过的九条里有五条已经
            不存在了。它给的是 `/models` 永远给不了的三样：端点地址本身、这个端点
            必需的 request 字段（DeepSeek 的 thinking、通义的 enable_thinking，两家
            拼法互发都 400），以及协议与本地服务的 CORS 提示。 */}
        <label>
          厂商预设
          <select
            value={cfg.preset}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value)!;
              repoint({
                preset: p.id,
                baseURL: p.baseURL,
                model: p.models[0] ?? cfg.model,
                protocol: p.protocol ?? 'openai-chat',
                // The vendor's required fields land here, for the models this
                // preset lists — that is all a preset does with them now. The
                // send path reads the configuration, never this table.
                requestByModel: { ...cfg.requestByModel, ...presetRequestByModel(p) },
              });
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
        {/* Its own control, not something read off the preset: `custom` and the
            two local presets have no vendor to derive it from, and one address
            can serve two protocols. */}
        <label>
          协议
          <select
            value={cfg.protocol}
            onChange={(e) => point({ protocol: e.target.value as ProtocolId, verdictByModel: {} })}
          >
            {Object.values(PROTOCOLS).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          端点
          <input value={cfg.baseURL} onChange={(e) => repoint({ baseURL: e.target.value })} />
        </label>
        <label>
          API Key
          <input
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={cfg.apiKey}
            onChange={(e) => repoint({ apiKey: e.target.value })}
          />
        </label>

        {/* 第 1 步。只要地址和 Key——模型名是端点的属性，问出来就不会过期。 */}
        <div className="row">
          <button className="primary" onClick={() => void onConnect()}>
            连接
          </button>
          <button onClick={() => setShowKey((v) => !v)}>{showKey ? '隐藏' : '显示'} Key</button>
        </div>

        {/* 既能从列表里选，也能手打一个列表里没有的：`/models` 只是候选，不是准入。
            同一份目录里有 503 的、500 的、要多一个字段才肯答的——那些是第 2 步量的。 */}
        <label>
          模型
          <input
            list="model-candidates"
            value={cfg.model}
            placeholder={models ? '从列表里选，或手打一个' : '先点「连接」拿列表，或直接手打'}
            onChange={(e) => showFields(point({ model: e.target.value }))}
          />
        </label>
        <datalist id="model-candidates">
          {(models ?? preset.models).map((m) => {
            const mark = VERDICT_MARK[cfg.verdictByModel[m] ?? 'unknown'];
            return <option key={m} value={m} {...(mark ? { label: mark } : {})} />;
          })}
        </datalist>
        {/* 量过的那几个，单独列出来——一份 424 条的下拉里，用户自己验收过的才是
            他真正要在里面挑的那一小撮。⚠️ 的也留着：知道哪个试过而不行，跟知道
            哪个行一样有用。 */}
        {measured.length > 0 && (
          <>
            <p className="hint">你在这个端点上验收过的（点一下就切过去）：</p>
            <div className="row">
              {measured.map(([m, v]) => (
                <button key={m} onClick={() => showFields(point({ model: m }))} disabled={m === cfg.model}>
                  {VERDICT_MARK[v]} {m}
                </button>
              ))}
            </div>
          </>
        )}
        {models === null && preset.models.length > 0 && (
          <p className="hint">列表里现在是预设自带的名字，可能已经过期——点「连接」换成这个端点真有的。</p>
        )}

        {/* 第 2 步。对着选定的这一个模型发一次真调用——探测本来就是对着某一个
            模型发的，模型没选就无从发起，所以这两段必须分开。 */}
        <div className="row">
          <button className="primary" onClick={() => void onVerify()}>
            验收并保存
          </button>
        </div>
        <p className={`note ${keyState.kind}`}>{keyState.text}</p>
        {/* 思考模式那堵墙：用户不知道 thinking 是什么，也不该知道两家厂商的
            字段名拼得不一样——按钮替他试出来。端点原话已经在上面那行里。 */}
        {(wall === 'thinking' || wall === 'refused') && (
          <div className="row">
            <button className="primary" onClick={() => void onDisableThinking()}>
              关掉思考，再试一次
            </button>
          </div>
        )}
        <p className="hint">{FORCED_TOOL_CHOICE_NOTE[verdictFor(cfg)]}</p>
        {verdictFor(cfg) === 'unsupported' && (
          <div className="row">
            <button onClick={() => void onOverride()}>仍然按可用处理</button>
          </div>
        )}

        {/* 折叠着，但摘要里写明现在到底替他加了什么——产品替用户改过的东西，
            用户要能看见，也要能改回去。 */}
        <details className="fields">
          <summary>
            这个模型的额外请求字段：{fieldsText || '无'}
          </summary>
          <input
            value={fieldsText}
            spellCheck={false}
            placeholder='{"enable_thinking": false}'
            onChange={(e) => editFields(e.target.value)}
          />
          <p className="hint">
            只发给「{cfg.model || '（还没选模型）'}」这一个模型；换个模型就换一套。多数模型不需要任何字段。
          </p>
          {fieldsError && <p className="note error">{fieldsError}</p>}
        </details>

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
      </details>

      {/* 走通过的路会被记下来，下次在同一个站点上当线索用。能看见，也能拿回去。 */}
      <details className="memory" onToggle={(e) => e.currentTarget.open && walked === null && void loadMemory()}>
        <summary>它记住的路</summary>
        {walked === null ? (
          <p className="note">正在读…</p>
        ) : walked.length === 0 ? (
          <p className="note">还没有记住任何一条——走通一趟之后才会有。</p>
        ) : (
          <>
            <ul className="walked">
              {walked.map((p) => (
                <li key={p.runId}>
                  <div className="walked-goal">{p.goal}</div>
                  <div className="walked-where">
                    {p.host} · {p.steps.join(' → ')}
                  </div>
                  <button onClick={() => void forget(p.runId)}>忘掉这条</button>
                </li>
              ))}
            </ul>
            <div className="row">
              <button onClick={() => void forget()}>全部忘掉（{walked.length} 条）</button>
            </div>
          </>
        )}
      </details>
    </details>
  );
}
