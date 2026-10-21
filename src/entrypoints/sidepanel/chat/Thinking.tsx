import type { ConversationRound } from '@/shared/conversation';
import { Icon } from '../ui/Icon';

const TOOL_NAME: Record<string, string> = {
  observe: '重新看了一眼页面',
  wait_for: '等页面上的一段文字',
  read_doc: '读了一份文档',
  point: '指出下一步',
  ask: '反过来问你',
  explain: '直接回答',
  done: '说已经到了',
};

const count = (n: number) => n.toLocaleString('en-US');

/**
 * 思考过程: what each round did — which tool, the model's own reason, what came
 * back, what it cost.
 *
 * Two ways of saying it. A turn still under way (`live`) shows its rounds as
 * they land, open, each line labelled (为什么 / 读的是 / 结果). A turn that has
 * landed folds them away under a quieter line — 夜航 a 「▸」, 景深 a pill — and
 * opened, reads as a footnote: the reason in italics, what came back.
 */
export function Thinking({
  rounds,
  open,
  live,
}: {
  rounds: readonly ConversationRound[];
  open?: boolean;
  /** This turn has not landed yet: more rounds may follow. */
  live?: boolean;
}) {
  if (rounds.length === 0) return null;
  return (
    <details className={`thinking${live ? ' live' : ''}`} {...(open ? { open: true } : {})}>
      <summary>
        {live && <span className="spinner" />}
        {!live && <span className="tg for-hud">▸ </span>}
        <span className="summary-text">{`思考过程 · ${rounds.length} 步${live ? '，还在继续' : ''}`}</span>
        <Icon name="down" size={12} />
      </summary>
      <ol>
        {rounds.map((r, i) => (
          <li key={i}>
            <span className="n">{i + 1}</span>
            <div className="round">
              <div className="what">{TOOL_NAME[r.tool] ?? r.tool}</div>
              {r.asked && (
                <div className="asked">
                  读的是：<span className="mono">{r.asked}</span>
                </div>
              )}
              {r.why && <div className="why">{live ? `为什么：${r.why}` : r.why}</div>}
              {r.got && <div className="got">结果：{r.got}</div>}
              {r.usage && (
                <div className="usage">
                  {count(r.usage.prompt)} + {count(r.usage.completion)} token
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
