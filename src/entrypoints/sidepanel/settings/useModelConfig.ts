import { useCallback, useEffect, useState } from 'react';
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

/** What the last step said, and which step said it — so it is shown under
 *  that step rather than somewhere the user is not looking. */
export interface StepNote {
  kind: 'busy' | 'ok' | 'error' | 'idle';
  text: string;
  from: 'connect' | 'verify';
}

/**
 * The model configuration's behaviour, apart from how it is laid out: two steps
 * — connect (address + key, the endpoint says what it has), then verify one
 * model with a real call, which is the only place a chosen model is written
 * down.
 */
export function useModelConfig() {
  const [cfg, setCfg] = useState<ProviderConfig>(DEFAULT_CONFIG);
  const [showKey, setShowKey] = useState(false);
  const [note, setNote] = useState<StepNote | null>(null);
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
  /** Whether what is *stored* would start a run — the form above it can be
   *  half-edited. The same rule the host asks (`call.ts`), so the page cannot
   *  say 「已配置」 about something the host will refuse. */
  const [configured, setConfigured] = useState<boolean | null>(null);

  const persist = useCallback(async (c: ProviderConfig) => {
    await saveConfig(c);
    setConfigured(modelIsConfigured(c));
  }, []);

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
      setConfigured(modelIsConfigured(c));
    });
  }, [showFields]);

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

  /** 预设不再是模型名的来源——名字会过期。它给的是 `/models` 永远给不了的三样：
   *  端点地址本身、这个端点必需的 request 字段，以及协议与本地服务的提示。 */
  const pickPreset = useCallback(
    (id: string) => {
      const p = PRESETS.find((x) => x.id === id);
      if (!p) return;
      repoint({
        preset: p.id,
        baseURL: p.baseURL,
        model: p.models[0] ?? cfg.model,
        protocol: p.protocol ?? 'openai-chat',
        // The vendor's required fields land here, for the models this preset
        // lists — that is all a preset does with them now. The send path reads
        // the configuration, never this table.
        requestByModel: { ...cfg.requestByModel, ...presetRequestByModel(p) },
      });
    },
    [cfg, repoint],
  );

  /** Its own control, not something read off the preset: `custom` and the two
   *  local presets have no vendor to derive it from, and one address can serve
   *  two protocols. */
  const pickProtocol = useCallback((protocol: ProtocolId) => point({ protocol, verdictByModel: {} }), [point]);

  const pickModel = useCallback((model: string) => showFields(point({ model })), [point, showFields]);

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
  const connect = useCallback(async () => {
    setNote({ kind: 'busy', text: '正在连接…', from: 'connect' });
    const r = await listModels(cfg);
    // No green for an endpoint that answered without a listing: it did not
    // fail, but nothing about it has been confirmed yet either.
    setNote({ kind: r.ok ? (r.models.length ? 'ok' : 'idle') : 'error', text: r.message, from: 'connect' });
    setModels(r.ok ? r.models : null);
    // An address and a key that got this far are worth keeping even if the
    // user stops here — what is *not* written is any claim about the model.
    if (r.ok) await persist(cfg);
  }, [cfg, persist]);

  /** Step 2: one real call with the model that was chosen — and the only
   *  place the chosen model gets written down. */
  const verify = useCallback(async () => {
    setNote({ kind: 'busy', text: `正在用「${cfg.model}」做一次最小真调用…`, from: 'verify' });
    const r = await verifyModel(cfg);
    setNote({ kind: r.ok ? 'ok' : 'error', text: r.message, from: 'verify' });
    setWall(r.wall ?? null);
    // What the probe learned is stored whether or not the verdict was good:
    // an endpoint measured as ignoring forced tool calls is refused before the
    // next request goes out (`guide/runner.ts`), which is the whole point of
    // asking. A run that learned nothing writes `unknown` — the same as never
    // having asked, which is the truth. A missing address or model means the
    // call never left; nothing was learned and nothing is worth storing.
    if (!r.forcedToolChoice) return;
    const next = withVerdict(cfg, r.forcedToolChoice);
    setCfg(next);
    await persist(next);
  }, [cfg, persist]);

  /**
   * 「关掉思考，再试一次」. The user does not know what a thinking mode is, and
   * should not have to learn which of two vendors' spellings this endpoint
   * accepts — so the button finds out and reports which one it was.
   */
  const disableThinking = useCallback(async () => {
    setNote({ kind: 'busy', text: '正在试这个端点认哪种写法…', from: 'verify' });
    const r = await disableThinkingAndVerify(cfg);
    setNote({ kind: r.ok ? 'ok' : 'error', text: r.message, from: 'verify' });
    setWall(null);
    // Nothing measured, nothing written — the configuration is left exactly as
    // the user had it rather than carrying a field that never worked.
    if (!r.fields) return;
    const fixed = withRequestFields(cfg, r.fields);
    const next = r.forcedToolChoice ? withVerdict(fixed, r.forcedToolChoice) : fixed;
    setCfg(next);
    showFields(next);
    await persist(next);
  }, [cfg, showFields, persist]);

  /** The way back out of a verdict. The switch's default is "not asked yet,
   *  send anyway"; when the probe answers wrongly — a one-off 500, a model
   *  that needed a field this endpoint's preset does not carry — the user gets
   *  the same right the default has. */
  const overrideVerdict = useCallback(async () => {
    const next = withVerdict(cfg, 'unknown');
    setCfg(next);
    await persist(next);
    setNote({ kind: 'idle', text: '已按「未知」保存：引导会照常发出「必须调用工具」。', from: 'verify' });
  }, [cfg, persist]);

  const setContextWindow = useCallback((n: number) => setCfg((c) => ({ ...c, contextWindow: n })), []);

  const preset = PRESETS.find((p) => p.id === cfg.preset) ?? PRESETS[PRESETS.length - 1]!;
  /** Verified models, the ones that work first — `unknown` is not a
   *  measurement and has nothing to show. */
  const measured = (Object.entries(cfg.verdictByModel) as [string, ForcedToolChoice][])
    .filter(([, v]) => v !== 'unknown')
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'supported' ? -1 : 1));

  return {
    cfg,
    configured,
    preset,
    models,
    measured,
    verdict: verdictFor(cfg),
    note,
    wall,
    showKey,
    toggleKey: () => setShowKey((v) => !v),
    fieldsText,
    fieldsError,
    pickPreset,
    pickProtocol,
    pickModel,
    setBaseURL: (baseURL: string) => repoint({ baseURL }),
    setApiKey: (apiKey: string) => repoint({ apiKey }),
    editFields,
    setContextWindow,
    connect,
    verify,
    disableThinking,
    overrideVerdict,
  };
}
