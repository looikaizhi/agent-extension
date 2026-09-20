import type { GuideIntentModule } from '@/agent/agents/guide/intent-module';
import { fn, str } from '@/agent/agents/guide/tool-schema';
import { shapeMismatch } from '@/agent/envelope/contract';
import type { Never, WaitUntil } from '@/shared/types';

/**
 * wait_for — a `Tool`: the model expects a piece of text to appear on the page
 * (or to go), says which, and says how long it is willing to wait (CONTEXT.md
 * `Tool`).
 *
 * Its own tool, never folded into `observe`: waiting only means something when
 * the model says what for and for how long. Folded in, the product would be
 * back to guessing how long to wait. And the timeout is the model's to hear
 * about — 「等了 N 秒，没等到 X」 comes back to it with the page as it is now,
 * and is never written down as a fact about the step on screen (CONTEXT.md
 * `Reading`).
 */

export const WAIT_UNTIL = ['appears', 'gone'] as const satisfies readonly WaitUntil[];
type _EveryUntilOffered = Never<Exclude<WaitUntil, (typeof WAIT_UNTIL)[number]>>;

/**
 * The longest one wait may run. Well inside the thirty idle seconds after
 * which Chrome may stop the service worker that is waiting for the answer, and
 * well inside the ~45 seconds the live harness gives each hop. A model that
 * needs longer waits again. (07c, decided by the owner.)
 */
export const WAIT_FOR_MAX_SECONDS = 10;

export interface WaitForEnvelope {
  intent: 'wait_for';
  until: WaitUntil;
  text: string;
  /** As the model wrote it; capped when the wait is sent (`consequence`). */
  seconds: number;
}

export const waitFor: GuideIntentModule<WaitForEnvelope> = {
  intent: 'wait_for',
  kind: 'tool',
  tool: () =>
    fn('wait_for', `等页面上出现（或消失）一段具体的文字，最多 ${WAIT_FOR_MAX_SECONDS} 秒。`, ['until', 'text', 'seconds'], {
      until: { type: 'string', enum: [...WAIT_UNTIL], description: 'appears=等它出现；gone=等它消失（例如「加载中」）。' },
      text: str('页面上看得见的一段具体文字：弹窗标题、按钮上的字、提示语。'),
      // No `maximum`: strict mode refuses the keyword outright. The cap is
      // said here and enforced when the wait is sent.
      seconds: { type: 'integer', description: `最多等几秒，不超过 ${WAIT_FOR_MAX_SECONDS}。` },
    }),
  policy: `- **wait_for**：你预计页面马上会出现（或去掉）某段**具体的文字**——弹窗标题、按钮上的字、「加载中」——而它此刻还不在（或还在）时用。说出那段文字，和最多等几秒（不超过 ${WAIT_FOR_MAX_SECONDS} 秒）。等到了、没等到，都会连同此刻的页面一起交回给你，由你决定下一步；说不出具体在等哪段文字，就不要用它。`,
  recognize: (args) => {
    if (!(WAIT_UNTIL as readonly string[]).includes(args.until as string)) return null;
    if (typeof args.text !== 'string' || typeof args.seconds !== 'number') return null;
    return { intent: 'wait_for', until: args.until as WaitUntil, text: args.text, seconds: args.seconds };
  },
  explain: () => shapeMismatch('wait_for', `until（appears 或 gone）+ text（字符串）+ seconds（数字）`),
  claimedRefs: () => [],
  violation: (envelope) =>
    envelope.text.trim() ? null : 'wait_for 没有说等哪段文字：text 要写页面上看得见的一段具体文字',
  rationales: (envelope) => [envelope.text],
  consequence: (state, envelope, { nextEffectId, call }) => {
    // Every model call opens a turn (`tryEmitCallModel`), so this is the one
    // the call belongs to; an empty turn is what it would be if it had none.
    const turn = state.turn ?? { table: state.table, rounds: [] };
    const seconds = Math.min(WAIT_FOR_MAX_SECONDS, Math.max(1, Math.round(envelope.seconds)));
    return {
      state: { ...state, turn: { ...turn, pending: { effectId: nextEffectId, call } } },
      effects: [{ kind: 'waitFor', effectId: nextEffectId, until: envelope.until, text: envelope.text, seconds }],
    };
  },
};
