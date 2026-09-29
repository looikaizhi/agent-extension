import { useEffect, useState } from 'react';
import type { PinnedStep as Pinned } from '@/shared/conversation';
import { Prose } from '../Prose';
import { Icon } from '../ui/Icon';
import { Progress } from './Progress';

/**
 * The step the user is meant to be doing, kept above the conversation where it
 * cannot scroll away. 跳到目标 stays on the page's own card: it hands the
 * keyboard over, and the user is looking at the page.
 */
export function PinnedStep({ step, onEnd }: { step: Pinned; onEnd: () => void }) {
  return (
    <section className="pinned" aria-label="此刻这一步">
      <Progress index={step.index} total={step.total} />
      <div className="step-title">{step.title}</div>
      {step.detail && (
        <div className="why">
          <Prose text={step.detail} />
        </div>
      )}
      {step.value !== undefined && <ValueToType value={step.value} />}
      <div className="row">
        <button onClick={onEnd}>结束引导</button>
      </div>
    </section>
  );
}

/**
 * What to type, and a button that copies it. Here rather than on the page's
 * card: the panel is an extension page, so the clipboard is there on every
 * site — plain http included — and clicking the button gives it the focus a
 * write needs. The user still types, or pastes, it themselves.
 */
function ValueToType({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="value-to-type">
      <span className="label">照着填</span>
      <code>{value}</code>
      <button
        className="icon-btn"
        aria-label={copied ? '已复制' : '复制'}
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}
