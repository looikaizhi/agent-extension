import { shapeMismatch } from '@/agent/envelope/contract';
import type { GuideIntentModule } from '../intent-module';
import { fn, str } from '../tool-schema';

/**
 * What the model is claiming as proof that the goal is reached, chosen from a
 * closed list before it writes `why`.
 *
 * The same forcing function `previous_step` uses, for the same reason: a free
 * sentence lets "I can see it" and "I assume so" read identically, and the
 * live failures were all the second kind wearing the first one's words. It
 * also makes the mistake countable — the trace records which kind was claimed,
 * so the next run can say which kind is unreliable instead of guessing.
 */
export const DONE_EVIDENCE = ['content_on_page', 'page_address', 'step_completed'] as const;
export type DoneEvidence = (typeof DONE_EVIDENCE)[number];

/**
 * The journey is over: nothing left on this page for the user to do.
 *
 * Its own intent rather than "a `guide` with an empty `steps`", because R-b
 * (`guide.ts`'s own rule) requires `steps` to be non-empty — expressing
 * completion that way would ask one shape to be both a violation and valid. No `ref` and no control name: there is nothing to point at, which is
 * the whole content of the message.
 */
export interface DoneEnvelope {
  intent: 'done';
  /** Absent when the model's value is not one of `DONE_EVIDENCE`: recognition
   *  drops it rather than refusing the envelope. */
  evidence?: DoneEvidence;
  why: string;
}

/**
 * done, as the guide agent answers with it — an `Output`: the model says the
 * user has arrived, and the run ends there.
 */
export const done: GuideIntentModule<DoneEnvelope> = {
  intent: 'done',
  tool: () =>
    fn('done', '只在用户要做的事已经做完时用。走不下去不是做完——那是 clarify。', ['evidence', 'why'], {
      // Named before `why` is written, so the claim has to be classified
      // rather than narrated. Live runs produced `done` on goals that had
      // never started, and a free sentence could not tell that apart from a
      // real arrival.
      evidence: {
        type: 'string',
        enum: [...DONE_EVIDENCE],
        description:
          '凭什么说做完了。content_on_page=用户要的东西已经显示在这一页上；page_address=页面地址本身表明已经到了；step_completed=用户要执行的那一步已经生效。三者都不成立就不要用 done。',
      },
      why: str('说明你凭这一页上的什么判断已经做完。'),
    }),
  // `done` is keyed on the goal being *reached*, not on the page having run
  // out of controls. The earlier wording — "这一页上确实再没有任何能推进目标的
  // 可操作控件" — was the same trigger `clarify` already has ("连一个能让用户更
  // 接近目标的入口都没有"), so two tools competed for one condition and the
  // model had nothing to separate them by. It showed: journeys ended in `done`
  // on goals that were never started (the corpus caught it twice), and 7 of 14
  // live rounds finished that way. The two are opposites and now say so.
  policy: `- **done**：**用户要做的事已经做完了。** **说了 done，引导就结束了**——用户不会再收到下一步，屏幕上的高亮也会撤掉。所以这不是一句可以顺口说的话：不确定就继续给 guide，走到真的到了再说。**"走不下去"和"已经做完"是相反的两件事：走不下去给 clarify，做完了才给 done。** 先分清用户要的是哪一种：
  - **他要看到某个东西**（看 issue 列表、看有哪些版本、读某份文件、确认用的是什么许可证）——**东西显示在这一页上，就是做完了**，没有下一步动作要做。这时给 done，evidence 用 content_on_page 或 page_address。不要因为"还能再点点别的"就继续给 guide。
    但**"这一页提到了它"不等于"这一页就是它"**：概览页、首页、详情页常常会顺带显示一个数字、一个名字、一条最新记录，那是摘要，不是用户要看的那一页。要看清单就得到清单上，要读某一份内容就得把那一份打开。分不清时问自己：**用户要的东西，是这一页的主体内容，还是这一页顺带提了一句？**
  - **他要完成某个动作**（把地址拿到手、把某项改掉、把东西提交出去）——**看见不算做完，必须有一步已经生效**。地址显示出来了、而表里还有一个复制按钮，那就指那个复制按钮，给 guide 不给 done。`,
  recognize: (args) => {
    if (typeof args.why !== 'string') return null;
    // Carried when recognisable, dropped otherwise — same discipline as
    // `previous_step`. Nothing downstream decides on it; it exists to make
    // the model name its grounds, and to be countable afterwards.
    const evidence = (DONE_EVIDENCE as readonly string[]).includes(args.evidence as string)
      ? (args.evidence as DoneEvidence)
      : undefined;
    return { intent: 'done', ...(evidence ? { evidence } : {}), why: args.why };
  },
  explain: () => shapeMismatch('done', 'why（字符串）'),
  // Nothing to point at is the message. R-a/R-e have no work here.
  claimedRefs: () => [],
  violation: () => null,
  rationales: (envelope) => [envelope.why],
  consequence: (state, envelope) => {
    // Terminal, and the steps go with it.
    //
    // It used to be a proposal: `status` stayed `active` and the highlight
    // stayed on whatever step was current, so the screen said two contradictory
    // things at once — the panel 「看起来已经到了」 and the overlay still
    // pointing at a button. A user who does the obvious thing and clicks the
    // highlighted control gets a re-plan, and the model says `done` again.
    // Measured across 21 live journeys: 11 of them proposed `done` more than
    // once, one did it five times, and 21 of 106 hops happened *after* the
    // model had already said it had arrived.
    //
    // The proposal reading was not wrong about the user's right to disagree —
    // it was wrong about where that belongs. Disagreeing starts a new guide
    // (`start` is the one input a finished thread still accepts); it is not a
    // reason to keep instructing someone you have just told they are done.
    return {
      state: { ...state, ending: 'model_done', steps: [], cursor: 0 },
      effects: [{ kind: 'done', why: envelope.why, ending: 'model_done' }],
    };
  },
};
