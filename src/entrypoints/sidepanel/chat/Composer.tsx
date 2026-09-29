import { Icon } from '../ui/Icon';

/**
 * Where the user talks — to start something, to answer a question, or to say
 * something while a guide is under way. 夜航 lays it out as a box with a hint
 * row, 景深 as one capsule; the markup is the same and the style decides.
 */
export function Composer({
  text,
  onText,
  onSend,
  placeholder,
  onEnd,
}: {
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  /** 结束, when something is under way with no step on screen to end it from. */
  onEnd?: () => void;
}) {
  return (
    <section className="composer">
      <label className="composer-field">
        <span className="sr-only">对引导说</span>
        <input
          value={text}
          placeholder={placeholder}
          onChange={(e) => onText(e.target.value)}
          // Enter while an input method is still composing picks a candidate;
          // it is not the user saying they are done.
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && onSend()}
        />
      </label>
      <div className="composer-foot">
        <span className="kbd-hint">↵ 发送</span>
        {onEnd && <button onClick={onEnd}>结束</button>}
        <button className="primary send" aria-label="发送" disabled={!text.trim()} onClick={onSend}>
          <Icon name="up" size={15} />
        </button>
      </div>
    </section>
  );
}
