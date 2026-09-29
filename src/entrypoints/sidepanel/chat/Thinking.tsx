import type { ConversationRound } from '@/shared/conversation';

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
 * back, what it cost. Folded by default; the turn still under way shows it open
 * and says it is not finished (`live`).
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
    <details className="thinking" {...(open ? { open: true } : {})}>
      <summary>
        {live && <span className="spinner" />}
        {`思考过程 · ${rounds.length} 步${live ? '，还在继续' : ''}`}
      </summary>
      <ol>
        {rounds.map((r, i) => (
          <li key={i}>
            <span className="n">{i + 1}</span>
            <div>
              <b>{TOOL_NAME[r.tool] ?? r.tool}</b>
              {r.asked && <span className="asked">{r.asked}</span>}
              {r.why && <span className="why">{r.why}</span>}
              {r.got && <span className="got">{r.got}</span>}
              {r.usage && (
                <span className="usage">
                  {count(r.usage.prompt)} + {count(r.usage.completion)} token
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
