import type { ReactNode } from 'react';
import type { ConversationEntry, EntryStep } from '@/shared/conversation';
import { stepLabels } from '@/shared/progress';
import { Prose } from '../Prose';
import { Icon, type IconName } from '../ui/Icon';
import {
  bindingTone,
  checkTone,
  describeBinding,
  describeCheck,
  describeEvidence,
  evidenceTone,
  type Tone,
} from '../view-model';
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
      return current ? <CurrentStep entry={entry} /> : <PastStep entry={entry} />;
    case 'answer':
      return (
        <div className="entry answer">
          <div className="kind">
            <Icon name="message" size={13} />
            回答
          </div>
          <div className="body">
            <Prose text={entry.text} />
            {entry.detail && <Prose text={entry.detail} />}
          </div>
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
          <div className="body">
            <Prose text={entry.text} />
            {entry.detail && <Prose text={entry.detail} />}
          </div>
          {entry.options && entry.options.length > 0 && (
            // Every candidate, none picked for the user (K-6): the answer is
            // theirs to type.
            <ul className="options">
              {entry.options.map((o) => (
                <li key={o.ref}>
                  <Icon name="key" size={14} weight={2} />
                  <span className="option">{o.label}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">在下面直接打字回答就行，我不替你选。</p>
          <Thinking rounds={entry.rounds ?? []} />
        </div>
      );
    case 'note':
      return entry.crossSite ? (
        <CrossSite entry={entry} actions={actions} />
      ) : (
        <Note entry={entry} {...(onRetry ? { onRetry } : {})} {...(onOpenModel ? { onOpenModel } : {})} />
      );
  }
}

/**
 * The host itself: a refusal, a failure, how a run ended. A call that never
 * got through (`canRetry`) is said as a failure; one the user has to put right
 * in the settings (`fix`) as a warning with the way there; the rest are just
 * said.
 */
function Note({ entry, onRetry, onOpenModel }: { entry: ConversationEntry; onRetry?: () => void; onOpenModel?: () => void }) {
  const tone = entry.fix ? 'fix' : entry.canRetry ? 'failed' : 'plain';
  return (
    <div className={`entry note ${tone}`}>
      <Icon name={tone === 'fix' ? 'warn' : tone === 'failed' ? 'alert' : 'info'} size={18} weight={2} />
      <div className="note-body">
        <div className="note-text">
          <Prose text={entry.text} />
        </div>
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
      </div>
    </div>
  );
}

/** The step about to leave the site: where from, where to, and — while the run
 *  waits on it — the two answers. */
function CrossSite({ entry, actions }: { entry: ConversationEntry; actions?: ReactNode }) {
  const hosts = entry.crossSite!;
  return (
    <div className={`entry cross-site${actions ? ' waiting' : ''}`}>
      <div className="kind">
        <Icon name="globe" size={13} weight={2} />
        要换一个网站
      </div>
      <div className="cross-title">{entry.text}</div>
      {entry.detail && (
        <div className="cross-text">
          <Prose text={entry.detail} />
        </div>
      )}
      <div className="hosts">
        <span className="from">{hosts.from}</span>
        <Icon name="right" size={14} />
        <span className="to">{hosts.to}</span>
      </div>
      {actions}
    </div>
  );
}

/** A step that is behind the user now: what it was, and what became of it. */
function PastStep({ entry }: { entry: ConversationEntry }) {
  const step = entry.step;
  const label = step ? stepLabels(step.index, step.total) : null;
  const outcome = step?.outcome ? OUTCOME[step.outcome] : null;
  return (
    <div className={`entry step past${outcome ? ` ${outcome.tone}` : ''}`}>
      {outcome && (
        <span className="badge">
          <Icon name={outcome.icon} size={12} weight={step?.outcome === 'used' ? 3 : 2.6} />
        </span>
      )}
      <div className="step-body">
        {label && <StepLabel label={label} />}
        <div className="step-title">{entry.text}</div>
        {outcome && (
          <div className={`outcome ${outcome.tone}`}>
            {step?.outcome === 'not_found' && <span className="spinner" />}
            {outcome.text}
          </div>
        )}
        <Thinking rounds={entry.rounds ?? []} />
      </div>
    </div>
  );
}

/** The step on screen now: its reason, the model's route, and the three axes. */
function CurrentStep({ entry }: { entry: ConversationEntry }) {
  const step = entry.step;
  const label = step ? stepLabels(step.index, step.total) : null;
  const outcome = step?.outcome ? OUTCOME[step.outcome] : null;
  return (
    <div className="entry step current">
      {label && <StepLabel label={label} suffix=" · 进行中" />}
      <div className="step-title">{entry.text}</div>
      {entry.detail && (
        <div className="step-detail">
          <Prose text={entry.detail} />
        </div>
      )}
      {outcome && (
        <div className={`outcome ${outcome.tone}`}>
          {step?.outcome === 'not_found' && <span className="spinner" />}
          {outcome.text}
        </div>
      )}
      {/* 整体路标：模型这次给的「前方的路」，原样展示，不拼接也不去重。第一站就是
          用户此刻所在的这一步。 */}
      {entry.route && entry.route.length > 0 && (
        <ol className="route">
          {entry.route.map((hop, i) => (
            <li key={i} className={i === 0 ? 'here' : ''}>
              <span className="mark for-hud">{String(i + 1).padStart(2, '0')}</span>
              <span className="mark for-depth" />
              <span className="hop">
                <b>{hop.at}</b>：{hop.goal}
              </span>
            </li>
          ))}
        </ol>
      )}
      {/* 三轴各自独立，互不合并（§5.7）：每个都有自己的名字、一句话和一个圆点。 */}
      {entry.axes && (
        <div className="axes">
          <Axis name="依据" tone={evidenceTone(entry.axes.evidence)} text={describeEvidence(entry.axes.evidence)} />
          <Axis name="到达" tone={checkTone(entry.axes.check)} text={describeCheck(entry.axes.check)} />
          <Axis name="绑定" tone={bindingTone(entry.axes.binding)} text={describeBinding(entry.axes.binding)} />
        </div>
      )}
      <Thinking rounds={entry.rounds ?? []} />
    </div>
  );
}

function StepLabel({ label, suffix = '' }: { label: { hud: string; depth: string }; suffix?: string }) {
  return (
    <div className="step-n">
      <span className="for-hud">{label.hud + suffix}</span>
      <span className="for-depth">{label.depth + suffix}</span>
    </div>
  );
}

function Axis({ name, tone, text }: { name: string; tone: Tone; text: string }) {
  return (
    <span className={`axis ${tone}`}>
      <span className="dot" />
      <span className="axis-name">{name}</span>
      <span className="axis-sep for-depth">·</span>
      {text}
    </span>
  );
}
