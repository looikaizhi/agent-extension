import type * as React from 'react';
import type { Conversation as ConversationData, ConversationEntry, ConversationRound, Pending } from '@/shared/conversation';
import { Prose } from './Prose';
import { describeBinding, describeCheck, describeEvidence } from './view-model';

/**
 * The conversation, as the host wrote it down.
 *
 * Nothing here is state: every render comes from one `ConversationView` the
 * panel pulled. The only thing the panel adds of its own is the draft of what
 * the model is writing right now, which is explicitly not the record —
 * `draft` below — and is replaced by the host's entry the moment it lands.
 */

const STEP_OUTCOME: Record<NonNullable<NonNullable<ConversationEntry['step']>['outcome']>, string> = {
  used: '你做了这一步',
  skipped: '跳过了',
  not_found: '页面上没找到它，还在找',
  not_actionable: '此刻点不了',
  gone: '它从页面上消失了',
};

const TOOL_NAME: Record<string, string> = {
  observe: '重新看了一眼页面',
  wait_for: '等页面上的一段文字',
  read_doc: '读了一份文档',
  point: '指出下一步',
  ask: '反过来问你',
  explain: '直接回答',
  done: '说已经到了',
};

function Thinking({ rounds, open, title }: { rounds: readonly ConversationRound[]; open?: boolean; title?: string }) {
  if (rounds.length === 0) return null;
  return (
    <details className="thinking" {...(open ? { open: true } : {})}>
      <summary>{title ?? `思考过程（${rounds.length} 步）`}</summary>
      <ol>
        {rounds.map((r, i) => (
          <li key={i}>
            <b>{TOOL_NAME[r.tool] ?? r.tool}</b>
            {r.asked && <span className="asked">{r.asked}</span>}
            {r.why && <span className="why">{r.why}</span>}
            {r.got && <span className="got">{r.got}</span>}
            {r.usage && (
              <span className="usage">
                {r.usage.prompt} + {r.usage.completion} token
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function Entry({ entry, onRetry }: { entry: ConversationEntry; onRetry?: () => void }) {
  if (entry.kind === 'said') return <div className="entry said">{entry.text}</div>;

  const body =
    entry.kind === 'step' ? (
      <>
        <div className="step-n">{entry.step && (entry.step.total === null ? `第 ${entry.step.index + 1} 步` : `步骤 ${entry.step.index + 1} / ${entry.step.total}`)}</div>
        <div className="step-title">{entry.text}</div>
        {entry.detail && <Prose text={entry.detail} />}
        {entry.step?.outcome && <div className="outcome">{STEP_OUTCOME[entry.step.outcome]}</div>}
        {/* 整体路标：模型这次给的，原样展示，不拼接也不去重。 */}
        {entry.route && entry.route.length > 0 && (
          <ol className="route">
            {entry.route.map((hop, i) => (
              <li key={i}>
                <b>{hop.at}</b>：{hop.goal}
              </li>
            ))}
          </ol>
        )}
        {/* 三轴各自独立，互不合并（§5.7）。 */}
        {entry.axes && (
          <div className="axes">
            <span title="Evidence">依据：{describeEvidence(entry.axes.evidence)}</span>
            <span title="Check">到达：{describeCheck(entry.axes.check)}</span>
            <span title="Binding">绑定：{describeBinding(entry.axes.binding)}</span>
          </div>
        )}
      </>
    ) : (
      <>
        <Prose text={entry.text} />
        {entry.detail && <Prose text={entry.detail} />}
        {/* A trip that failed, offered again. Only on the newest such note
            (`onRetry` is passed for that one alone): an older failure has
            already been overtaken by whatever happened after it. */}
        {onRetry && (
          <button className="retry" onClick={onRetry}>
            再试一次
          </button>
        )}
        {entry.options && entry.options.length > 0 && (
          // Every candidate, none picked for the user (K-6): the answer is
          // theirs to type.
          <ul className="options">
            {entry.options.map((o) => (
              <li key={o.ref}>{o.label}</li>
            ))}
          </ul>
        )}
      </>
    );

  return (
    <div className={`entry ${entry.kind}`}>
      {body}
      <Thinking rounds={entry.rounds ?? []} />
    </div>
  );
}

export function Conversation({
  conversation,
  pending,
  draft,
  storageFull,
  earlier,
  onRetry,
  endRef,
}: {
  conversation: ConversationData;
  pending: Pending;
  /** The store had no room for the newest thing that happened. */
  storageFull?: true;
  /** Entries older than the ones shown: kept, but not carried on every pull. */
  earlier?: number;
  /** What the model is writing right now, as far as it has arrived. */
  draft: string;
  /** 「再试一次」 on the last call that never got through. */
  onRetry?: () => void;
  /** The bottom of the list, so the newest entry can be scrolled to. */
  endRef?: React.Ref<HTMLDivElement>;
}) {
  const working = pending.kind === 'thinking' || pending.kind === 'running_tool';
  // Nothing to try again while something is already under way, and only the
  // last word of the conversation can be the one still standing.
  const last = conversation.entries.at(-1);
  const retryable = !working && last?.canRetry ? last.id : null;
  return (
    <div className="conversation">
      {/* 更早的话去哪了，以及此刻还写不写得下——都说出来，不让这条对话
          悄悄地少掉东西。 */}
      {conversation.dropped ? <div className="conversation-note">更早的 {conversation.dropped} 条已不再保留</div> : null}
      {earlier ? <div className="conversation-note">更早还有 {earlier} 条，没有载入</div> : null}
      {storageFull && <div className="conversation-note warn">这条对话写不下了：刚刚发生的事没能记下来</div>}
      {conversation.entries.map((e) => (
        <Entry key={e.id} entry={e} {...(e.id === retryable && onRetry ? { onRetry } : {})} />
      ))}

      {/* The turn that has not landed yet: what it has done so far, and what
          it is writing. Both are drafts — the host's entry replaces them. */}
      {working && (
        <div className="entry working">
          <Thinking rounds={conversation.draft ?? []} open title={conversation.draft?.length ? `思考过程（${conversation.draft.length} 步，还在继续）` : ''} />
          {draft ? <Prose text={draft} /> : <div className="dots">{pending.kind === 'running_tool' ? '正在看页面…' : '正在想…'}</div>}
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
