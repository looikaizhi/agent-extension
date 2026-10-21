import { Icon } from '../ui/Icon';
import { callRows, summarizeCost, type CallRecord } from '../view-model';
import { PageBar } from './PageBar';

const n = (x: number) => x.toLocaleString('en-US');

/**
 * 本次用量: what the model calls this panel carried out have cost since it
 * was opened — the sum first, then each call.
 */
export function Usage({ calls, onBack }: { calls: readonly CallRecord[]; onBack: () => void }) {
  const cost = summarizeCost(calls);

  return (
    <div className="settings-page usage-page">
      <PageBar
        title="本次用量"
        parent="工具与设置"
        backLabel="返回工具与设置"
        onBack={onBack}
        aside={<span className="page-bar-note">从打开侧栏算起</span>}
      />

      {cost.totalCalls === 0 ? (
        <p className="callout quiet">
          <Icon name="info" />
          <span>这个侧栏还没有调用过模型。开始一次引导或问一个问题，这里就会记下每次调用用了多少 token。</span>
        </p>
      ) : (
        <>
          <section className="card usage-total">
            <div className="usage-head">
              <div>
                <div className="label">合计</div>
                <div className="usage-big">
                  <b>{n(cost.total)}</b>
                  <span>token</span>
                </div>
              </div>
              <span className={`chip ${cost.estimated ? 'warn' : 'ok'}`}>{cost.estimated ? '含估算值' : '真实用量'}</span>
            </div>
            <div className="usage-calls">
              {cost.totalCalls} 次调用 · 主调用 {cost.primaryCalls} / 修复 {cost.repairCalls}
            </div>
            {cost.prompt + cost.completion > 0 && (
              <div className="ratio" aria-hidden="true">
                <span className="prompt" style={{ flexGrow: cost.prompt }} />
                <span className="completion" style={{ flexGrow: cost.completion }} />
              </div>
            )}
            <div className="legend">
              <span>
                <i className="prompt" />
                prompt <b>{n(cost.prompt)}</b>
              </span>
              <span>
                <i className="completion" />
                completion <b>{n(cost.completion)}</b>
              </span>
            </div>
            {cost.unknownCostCalls > 0 && (
              <p className="unreported">
                <Icon name="warn" size={13} />
                <span>{cost.unknownCostCalls} 次调用没返回用量，没算进合计</span>
              </p>
            )}
          </section>

          <section className="card calls-card">
            <h3>每次调用</h3>
            <ol className="call-rows">
              {callRows(calls).map((r) => (
                // A repair round's figure is on the call it repaired, so its
                // whole row steps back.
                <li key={r.n} className={r.usage === 'merged' ? 'merged' : ''}>
                  <span className="call-n">#{r.n}</span>
                  <span className="call-what">
                    {r.kind === 'primary' ? '主调用' : '修复'}
                    {r.usage === 'merged' && ` · 用量合并在 #${r.mergedInto}`}
                    {r.usage && r.usage !== 'merged' && r.usage.estimated && <span className="estimated">估算</span>}
                  </span>
                  <span className={`call-num${r.usage === null ? ' warn' : ''}`}>
                    {r.usage === 'merged' ? '—' : r.usage === null ? '没返回用量' : `${n(r.usage.prompt)} + ${n(r.usage.completion)}`}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <p className="usage-foot">估算值按字符数折算，只在端点没报用量时用。只算这个侧栏发出的调用。</p>
        </>
      )}
    </div>
  );
}
