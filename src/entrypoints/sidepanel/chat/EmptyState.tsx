import { Icon, type IconName } from '../ui/Icon';

/** Things worth saying on any page — a click puts one in the box, it is not sent.
 *  Focus stays where it is: `focus()` is the content script's alone
 *  (`architecture.spec.ts`), and 发送 lights up either way. */
const EXAMPLES: readonly { text: string; icon: IconName }[] = [
  { text: '这一页是做什么的？', icon: 'message' },
  { text: '这一页上我能做哪些事？', icon: 'message' },
  { text: '带我把这一页逐项看一遍', icon: 'right' },
];

/**
 * Before anything has been said on this tab: what the panel is for, and a few
 * ways to start. An example only fills the box — the user still sends it, and
 * can change it first.
 */
export function EmptyState({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="empty-state">
      <span className="empty-mark">
        <Icon name="pointer" size={24} />
      </span>
      <div className="empty-title">想在这一页做什么？</div>
      <p>说出目标，我在页面上一步一步指给你；也可以直接问这一页的问题。我只指路，不替你点。</p>
      <div className="examples">
        {EXAMPLES.map((ex) => (
          <button key={ex.text} onClick={() => onExample(ex.text)}>
            <Icon name={ex.icon} size={14} />
            {ex.text}
          </button>
        ))}
      </div>
    </div>
  );
}
