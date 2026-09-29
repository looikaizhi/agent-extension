import { useId, type ReactNode } from 'react';
import { useCombobox } from 'downshift';
import { isLocalEndpoint } from '@/agent/provider/call';
import { PRESETS, type ForcedToolChoice, type ProtocolId } from '@/shared/settings';
import { Icon } from '../ui/Icon';
import { PageBar } from './PageBar';
import { useModelConfig, type StepNote } from './useModelConfig';

/** What the protocol switch says on each half — the family name is on its label. */
const PROTOCOL_NAME: Record<ProtocolId, string> = {
  'openai-chat': 'Chat Completions',
  'openai-responses': 'Responses',
};

/**
 * What the stored switch says, in one line — read off the *saved* value, so
 * closing the panel does not erase it.
 *
 * It used to be transient component state: a verdict was written to storage,
 * refused every call from then on (`guide/runner.ts`), and left no trace on
 * screen and no way back. A measurement the product acts on has to be visible
 * where it was made.
 */
const FORCED_TOOL_CHOICE_NOTE: Record<ForcedToolChoice, { text: string; tone: 'open' | 'ok' | 'err' }> = {
  unknown: { text: '「必须调用工具」这一条还没在这个模型上验收过——引导照常会试。', tone: 'open' },
  supported: { text: '已实测：这个模型认「必须调用工具」。', tone: 'ok' },
  unsupported: {
    text: '已实测：这个模型忽略「必须调用工具」。引导的每一步都要靠它，所以它的每一次调用都会被提前拦下——在这个端点上换一个模型，或者按下面那个出口。',
    tone: 'err',
  },
};

/**
 * 模型配置: connect, then pick one model and verify it with a real call. The
 * behaviour is `useModelConfig`; this is only where each piece sits.
 */
export function ModelConfig({ onBack }: { onBack: () => void }) {
  const m = useModelConfig();
  const { cfg, preset, note } = m;
  const busy = note?.kind === 'busy';
  const ids = { preset: useId(), protocol: useId(), url: useId(), key: useId(), window: useId() };
  const verdict = FORCED_TOOL_CHOICE_NOTE[m.verdict];

  return (
    <div className="settings-page">
      <PageBar
        title="模型配置"
        parent="工具与设置"
        backLabel="返回工具与设置"
        onBack={onBack}
        aside={m.configured !== null && <span className={`chip${m.configured ? ' ok' : ''}`}>{m.configured ? '已配置' : '未配置'}</span>}
      />

      <p className="callout quiet">
        <Icon name="lock" />
        <span>Key 只存在这台设备的扩展存储里，不会同步到云端，只会发往你在下面填的端点。</span>
      </p>

      <section className="card">
        <div className="card-head">
          <span className="step-n">第 1 步</span>
          <h3>连上端点</h3>
        </div>
        {/* 预设不再是模型名的来源——名字会过期，2026-09-25 核过的九条里有五条已经
            不存在了。它给的是 `/models` 永远给不了的三样：端点地址本身、这个端点
            必需的 request 字段（DeepSeek 的 thinking、通义的 enable_thinking，两家
            拼法互发都 400），以及协议与本地服务的 CORS 提示。 */}
        <div>
          <label htmlFor={ids.preset}>厂商预设</label>
          <span className="select">
            <select id={ids.preset} value={cfg.preset} onChange={(e) => m.pickPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <Icon name="down" />
          </span>
        </div>
        {preset.note && (
          <p className="callout warn">
            <Icon name="warn" />
            <span>{preset.note}</span>
          </p>
        )}
        <div>
          <div className="label" id={ids.protocol}>
            协议 · OpenAI 兼容
          </div>
          <div className="segmented" role="group" aria-labelledby={ids.protocol}>
            {(Object.keys(PROTOCOL_NAME) as ProtocolId[]).map((p) => (
              <button key={p} aria-pressed={cfg.protocol === p} onClick={() => m.pickProtocol(p)}>
                {PROTOCOL_NAME[p]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor={ids.url}>端点</label>
          <input id={ids.url} className="mono" spellCheck={false} value={cfg.baseURL} onChange={(e) => m.setBaseURL(e.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.key}>API Key</label>
          <span className="field">
            <input
              id={ids.key}
              className="mono"
              type={m.showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={isLocalEndpoint(cfg.baseURL) ? '本地服务通常不用填' : ''}
              value={cfg.apiKey}
              onChange={(e) => m.setApiKey(e.target.value)}
            />
            <button className="icon-btn" aria-label={m.showKey ? '隐藏 Key' : '显示 Key'} aria-pressed={m.showKey} onClick={m.toggleKey}>
              <Icon name="eye" size={15} />
            </button>
          </span>
        </div>
        {/* 只要地址和 Key——模型名是端点的属性，问出来就不会过期。 */}
        <div className="row center">
          <button className="primary" disabled={busy} onClick={() => void m.connect()}>
            {m.models ? '重新连接' : '连接'}
          </button>
          {!m.models && <span className="hint">只要地址和 Key，模型列表问端点要</span>}
        </div>
        {note?.from === 'connect' && <StepCallout note={note} />}
      </section>

      <section className="card">
        <div className="card-head">
          <span className="step-n">第 2 步</span>
          <h3>选模型并验收</h3>
        </div>
        {/* 既能从列表里选，也能手打一个列表里没有的：`/models` 只是候选，不是准入。
            同一份目录里有 503 的、500 的、要多一个字段才肯答的——那些是这一步量的。 */}
        <ModelPicker
          value={cfg.model}
          candidates={m.models ?? preset.models}
          listed={m.models !== null}
          verdicts={cfg.verdictByModel}
          onChange={m.pickModel}
        />
        {m.models === null && preset.models.length > 0 && (
          <p className="hint">列表里现在是预设自带的名字，可能已经过期——点「连接」换成这个端点真有的。</p>
        )}
        {/* 量过的那几个，单独列出来——一份 424 条的下拉里，用户自己验收过的才是
            他真正要在里面挑的那一小撮。跑不动的也留着：知道哪个试过而不行，跟
            知道哪个行一样有用。 */}
        {m.measured.length > 0 && (
          <div>
            <p className="hint">你在这个端点上验收过的，点一下就切过去：</p>
            <div className="chips">
              {m.measured.map(([name, v]) => (
                <button key={name} className={`chip ${v === 'supported' ? 'ok' : 'err'}`} disabled={name === cfg.model} onClick={() => m.pickModel(name)}>
                  <Icon name={v === 'supported' ? 'check' : 'ban'} size={10} />
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 对着选定的这一个模型发一次真调用——探测本来就是对着某一个模型发的，
            模型没选就无从发起，所以这两步必须分开。 */}
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void m.verify()}>
            验收并保存
          </button>
        </div>
        {note?.from === 'verify' && (
          <StepCallout note={note} {...(m.wall === 'busy' ? { tone: 'warn' as const } : {})}>
            {/* 思考模式那堵墙：用户不知道 thinking 是什么，也不该知道两家厂商的
                字段名拼得不一样——按钮替他试出来。端点原话已经在上面那句里。 */}
            {(m.wall === 'thinking' || m.wall === 'refused') && (
              <button className="primary" onClick={() => void m.disableThinking()}>
                关掉思考，再试一次
              </button>
            )}
          </StepCallout>
        )}
        <p className={`verdict ${verdict.tone}`}>
          <span className="dot" />
          <span>{verdict.text}</span>
        </p>
        {m.verdict === 'unsupported' && (
          <div className="row">
            <button onClick={() => void m.overrideVerdict()}>仍然按可用处理</button>
          </div>
        )}
        {/* 折叠着，但摘要里写明现在到底替他加了什么——产品替用户改过的东西，
            用户要能看见，也要能改回去。 */}
        <details className="fields">
          <summary>
            <span className="fields-id">
              <span>这个模型的额外请求字段</span>
              <code>{m.fieldsText || '无'}</code>
            </span>
            <Icon name="down" />
          </summary>
          <input
            className={`mono${m.fieldsError ? ' invalid' : ''}`}
            aria-label="额外请求字段"
            value={m.fieldsText}
            spellCheck={false}
            placeholder='{"enable_thinking": false}'
            onChange={(e) => m.editFields(e.target.value)}
          />
          {m.fieldsError && <p className="note error">{m.fieldsError}</p>}
          <p className="hint">只发给「{cfg.model || '（还没选模型）'}」这一个模型；换个模型就换一套。多数模型不需要任何字段。</p>
        </details>
      </section>

      <section className="card">
        <h3>
          <label htmlFor={ids.window}>上下文窗口</label>
        </h3>
        <span className="field">
          <input
            id={ids.window}
            className="mono"
            type="number"
            min={4_000}
            max={2_000_000}
            value={cfg.contextWindow}
            onChange={(e) => m.setContextWindow(Number(e.target.value))}
          />
          <span className="unit">token</span>
        </span>
        <p className="hint">这个模型一次能读多少 token。填 4,000 到 2,000,000 之间。</p>
      </section>
    </div>
  );
}

/** What the step just said, under the step that said it. */
function StepCallout({ note, tone, children }: { note: StepNote; tone?: 'warn'; children?: ReactNode }) {
  const t = tone ?? { busy: 'busy', ok: 'ok', idle: 'quiet', error: 'err' }[note.kind];
  return (
    <div className={`callout ${t}`} role="status">
      {note.kind === 'busy' ? (
        <span className="spinner" />
      ) : (
        <Icon name={note.kind === 'ok' ? 'check' : note.kind === 'idle' ? 'info' : tone === 'warn' ? 'warn' : 'alert'} />
      )}
      <div className="callout-body">
        <span>{note.text}</span>
        {children}
      </div>
    </div>
  );
}

/**
 * The model box: type any name, or pick one of the candidates. A list
 * rather than the browser's `<datalist>`, because each candidate carries what
 * this user measured on it — and a datalist cannot show that.
 *
 * The marks are deliberately not a recommendation: the only models marked are
 * the ones *this user* verified on *this* endpoint. Nothing is predicted, and
 * a model nobody has tried carries no mark at all.
 */
function ModelPicker({
  value,
  candidates,
  listed,
  verdicts,
  onChange,
}: {
  value: string;
  candidates: readonly string[];
  /** The candidates came from this endpoint — otherwise they are the preset's own names. */
  listed: boolean;
  verdicts: Readonly<Record<string, ForcedToolChoice>>;
  onChange: (model: string) => void;
}) {
  // A name taken from the list opens the whole list again; a half-typed one
  // narrows it.
  const q = value.trim().toLowerCase();
  const items = !q || candidates.includes(value) ? [...candidates] : candidates.filter((c) => c.toLowerCase().includes(q));
  const { isOpen, highlightedIndex, getLabelProps, getInputProps, getToggleButtonProps, getMenuProps, getItemProps } = useCombobox({
    items,
    // Only the text is controlled. A controlled `selectedItem` that turns
    // `null` (the stored model is not among the candidates) makes downshift
    // write `''` back into the box — which would erase the configured model.
    inputValue: value,
    onInputValueChange: ({ inputValue }) => onChange(inputValue),
    // Escape on a closed list would empty the box, and with it the model the
    // configuration names. Here it only closes the list.
    stateReducer: (state, { type, changes }) =>
      type === useCombobox.stateChangeTypes.InputKeyDownEscape
        ? { ...changes, inputValue: state.inputValue, selectedItem: state.selectedItem }
        : changes,
  });
  const open = isOpen && items.length > 0;

  return (
    <div className="combo">
      <label {...getLabelProps()}>模型</label>
      <span className={`field${open ? ' open' : ''}`}>
        <input
          {...getInputProps({
            className: 'mono',
            spellCheck: false,
            placeholder: listed ? '从列表里选，或手打一个' : '先点「连接」拿列表，或直接手打',
          })}
        />
        <button className="icon-btn" aria-label="模型列表" {...getToggleButtonProps()}>
          <Icon name="down" size={14} />
        </button>
      </span>
      <div className="combo-menu" hidden={!open}>
        <div className="combo-head">{listed ? '这个端点列出的' : '预设自带的名字'}</div>
        <ul {...getMenuProps()}>
          {open &&
            items.map((item, index) => (
              <li
                key={item}
                className={`${highlightedIndex === index ? 'hl' : ''}${item === value ? ' on' : ''}`}
                {...getItemProps({ item, index })}
              >
                <span className="name">{item}</span>
                <VerdictBadge verdict={verdicts[item] ?? 'unknown'} />
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: ForcedToolChoice }) {
  if (verdict === 'unknown') return null;
  return verdict === 'supported' ? (
    <span className="verdict-badge ok">
      <Icon name="check" size={10} />
      验收过
    </span>
  ) : (
    <span className="verdict-badge err">
      <Icon name="ban" size={10} />
      跑不动
    </span>
  );
}
