import type { ReactNode } from 'react';
import type { ConversationEntry, EntryStep } from '@/shared/conversation';
import { Prose } from '../Prose';
import { Icon, type IconName } from '../ui/Icon';
import {
  bindingTone,
  checkTone,
  describeBinding,
  describeCheck,
  describeEvidence,
  evidenceTone,
} from '../view-model';
import { stepLabels } from '@/shared/progress';
import { Thinking } from './Thinking';

const OUTCOME: Record<NonNullable<EntryStep['outcome']>, { text: string; tone: 'ok' | 'warn' | 'err' | 'muted'; icon: IconName }> = {
  used: { text: '你做了这一步', tone: 'ok', icon: 'check' },
  skipped: { text: '跳过了', tone: 'muted', icon: 'skip' },
  not_found: { text: '页面上没找到它，还在找', tone: 'warn', icon: 'search' },
  not_actionable: { text: '此刻点不了', tone: 'warn', icon: 'ban' },
  gone: { text: '它从页面上消失了', tone: 'err', icon: 'x' },
};

/**
 * One thing that happened, as the host wrote it down.
 *
 * `current` marks the step on screen right now (the one pinned above);
 * `onRetry` is passed for the newest call that never got through, and only
 * that one; `actions` are buttons that belong under this entry while the run
 * waits on them (the cross-site choice); `onOpenModel` is where a note whose
 * cure is the model configuration (`fix`) sends the user.
 */
export function Entry({
  entry,
  current,
  onRetry,
  actions,
  onOpenModel,
}: {
  entry: ConversationEntry;
  current?: boolean;
  onRetry?: () => void;
  actions?: ReactNode;
  onOpenModel?: () => void;
}) {
  switch (entry.kind) {
    case 'said':
      return <div className="entry said">{entry.text}</div>;
    case 'step':
      return <StepEntry entry={entry} current={current === true} />;
    case 'answer':
      return (
        <div className="entry answer">
          <div className="kind">
            <Icon name="message" size={13} />
            回答
          </div>
          <Prose text={entry.text} />
          {entry.detail && <Prose text={entry.detail} />}
          <Thinking rounds={entry.rounds ?? []} />
        </div>
      );
    case 'ask':
      return (
        <div className="entry ask">
          <div className="kind">
            <Icon name="question" size={13} />
            想确认一下
          </div>
          <Prose text={entry.text} />
          {entry.detail && <Prose text={entry.detail} />}
          {entry.options && entry.options.length > 0 && (
            // Every candidate, none picked for the user (K-6): the answer is
            // theirs to type.
            <ul className="options">
              {entry.options.map((o) => (
                <li key={o.ref}>{o.label}</li>
              ))}
            </ul>
          )}
          <p className="hint">在下面直接打字回答就行，我不替你选。</p>
          <Thinking rounds={entry.rounds ?? []} />
        </div>
      );
    case 'note':
      // The host itself: a refusal, a failure, how a run ended. A call that
      // never got through (`canRetry`) is said as a failure, one the user
      // has to fix in the settings as a warning with the way there; the rest
      // are just said.
      return (
        <div className={`entry note${entry.fix ? ' fix' : entry.canRetry ? ' failed' : ''}`}>
          <Icon name={entry.fix ? 'warn' : entry.canRetry ? 'alert' : actions ? 'globe' : 'info'} size={16} />
          <div className="note-body">
            <Prose text={entry.text} />
            {entry.detail && (
              <div className="note-detail">
                <Prose text={entry.detail} />
              </div>
            )}
            {onRetry && (
              <button className="retry" onClick={onRetry}>
                <Icon name="refresh" size={13} />
                再试一次
              </button>
            )}
            {entry.fix === 'model' && onOpenModel && (
              <button className="link" onClick={onOpenModel}>
                打开模型配置 →
              </button>
            )}
            {actions}
          </div>
        </div>
      );
  }
}

function StepEntry({ entry, current }: { entry: ConversationEntry; current: boolean }) {
  const step = entry.step;
  const label = step ? stepLabels(step.index, step.total) : null;
  const outcome = step?.outcome ? OUTCOME[step.outcome] : null;
  return (
    <div className={`entry step${current ? ' current' : ''}`}>
      {label && (
        <div className="step-n">
          <span className="for-hud">{label.hud}</span>
          <span className="for-depth">{label.depth}</span>
          {current && ' · 进行中'}
        </div>
      )}
      <div className="step-title">{entry.text}</div>
      {entry.detail && <Prose text={entry.detail} />}
      {outcome && (
        <div className={`outcome ${outcome.tone}`}>
          <Icon name={outcome.icon} size={13} />
          {outcome.text}
        </div>
      )}
      {/* 整体路标：模型这次给的，原样展示，不拼接也不去重。 */}
      {entry.route && entry.route.length > 0 && (
        <ol className="route">
          {entry.route.map((hop, i) => (
            <li key={i}>
              <span className="mark">{String(i + 1).padStart(2, '0')}</span>
              <span>
                <b>{hop.at}</b>：{hop.goal}
              </span>
            </li>
          ))}
        </ol>
      )}
      {/* 三轴各自独立，互不合并（§5.7）：每个都有自己的一句话和一个圆点。 */}
      {entry.axes && (
        <div className="axes">
          <span className={`axis ${evidenceTone(entry.axes.evidence)}`} title="依据">
            <span className="dot" />
            {describeEvidence(entry.axes.evidence)}
          </span>
          <span className={`axis ${checkTone(entry.axes.check)}`} title="到达">
            <span className="dot" />
            {describeCheck(entry.axes.check)}
          </span>
          <span className={`axis ${bindingTone(entry.axes.binding)}`} title="绑定">
            <span className="dot" />
            {describeBinding(entry.axes.binding)}
          </span>
        </div>
      )}
      <Thinking rounds={entry.rounds ?? []} />
    </div>
  );
}
