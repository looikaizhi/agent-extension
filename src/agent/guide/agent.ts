import type { ChatMessage, ToolDef } from '@/agent/provider';
import type { PromptTable } from '@/core/extractor/types';
import type { Envelope, ParseResult } from '@/agent/plan/contract';
import type { GuideHistory } from '@/agent/plan/prompt';
import type { UnknownIntentEnvelope, ValidateResult } from '@/agent/plan/validate';
import { GUIDE_TOOL_SYSTEM, buildGuideUserMessage } from '@/agent/plan/prompt';
import { parseContract, parseToolContract } from '@/agent/plan/contract';
import { validateEnvelope } from '@/agent/plan/validate';

/**
 * The guide agent, in one place.
 *
 * A model call in this codebase is spread across two processes and eight
 * files by necessity, not by choice: ADR 0002 puts the SSE request in the
 * side panel because a service worker is killed at 30 seconds, and ADR
 * 0001/0009 keep the decisions in a pure reducer that never touches the
 * network. Both constraints are load-bearing and neither is negotiable. What
 * they cost is the ability to read the agent: to see, in one screen, what
 * system prompt it sends, what user message it builds, and what it does with
 * the answer. `machine.ts` imported the parser, `effects.ts` imported the
 * prompt builders, and nothing anywhere named the thing they belonged to.
 *
 * This file names it. `guideAgent` is a façade over `plan/*`, deliberately
 * thin: every method here forwards to the function that already implements
 * it, and `plan/prompt.ts` / `plan/contract.ts` / `plan/validate.ts` remain
 * the implementations. Nothing was moved and nothing was rewritten, so the
 * golden corpus (`tests/unit/fixtures/golden-guide-envelopes.ts`) replays
 * byte for byte across this change — which is the only reason to trust that
 * a refactor of the call path changed no behaviour.
 *
 * Pure by construction: no `fetch`, no `chrome.*`, no `await`. Sending the
 * messages this file builds is `guide/runner.ts`'s job, and the architecture
 * guard keeps `host/` from ever reaching that far.
 */

/**
 * Everything the guide agent needs to know to plan its next move: the user's
 * goal, the page as it is right now, and where this guide has already been.
 *
 * The same three fields cross the wire as `CallModelParams` (`host/effect.ts`)
 * — not a coincidence, since shipping this context to the panel is what that
 * wire is *for*. They stay two declarations all the same: `effect.ts` states
 * in its own header that it is deliberately a leaf, duplicating a few field
 * lists rather than importing, and collapsing one of those duplicates would
 * quietly repeal that. Structural typing means a `CallModelParams` is already
 * accepted wherever a `GuideContext` is asked for, so the duplication costs
 * nothing at the call site; if the two ever need to diverge, they can.
 */
export interface GuideContext {
  goal: string;
  table: PromptTable;
  history: GuideHistory;
  /** Human-authored notes about the site this page belongs to, from its pack
   *  (`core/packs`). Absent for every site without one, which is most of them
   *  — the system message stays general and this is where a site's own
   *  vocabulary goes instead. */
  siteNotes?: string;
}

export const guideAgent = {
  name: 'guide',

  /**
   * The four envelopes as callable functions — the whole output contract,
   * expressed the way every mainstream endpoint expects it rather than as a
   * bespoke text format only a strong model can follow.
   *
   * `steps[].ref` is an enum of this snapshot's refs, rebuilt per call. It
   * costs 4–6 tokens per element (each ref then travels twice, once in the
   * table and once here, so the price grows with the page) and it was dropped
   * once on the argument that it does not deliver what it promises: across
   * 110 calls with `strict: true` the model still produced an empty ref, a
   * ref that was a sentence of prose, and a ref for an element not on the
   * page.
   *
   * It is back, but the case for it is thinner than the case that removed it,
   * and the honest version is worth stating: a capture without it produced a
   * `guide` with no `steps` in 4 of 16 draws against 1 of 16 with it, which
   * looked decisive until a third capture — enum present — produced 5 of 16.
   * Sixteen draws cannot separate those. What the enum is *known* to do is
   * hold the ref inside the table: the last live run had 0 violations in 79
   * calls. R-a runs anyway, because 0 in 79 is not a guarantee.
   *
   * `strict: true` for the same reason: a `required` array the model was
   * dropping in 2 of 16 draws stopped being dropped. Partial enforcement is
   * still worth having.
   *
   * No `intent` property anywhere: the function name carries it (see
   * `parseToolContract`), and asking for it makes the model write prose.
   *
   * The descriptions carry the *bar* for reaching a tool, not just a label.
   * They were one-liners first — `clarify: '先问用户'` — and four tools offered
   * as peers with cheap-sounding labels moved the model from 1% clarify to
   * 16%, with journeys running half as long: it stopped and asked whenever a
   * page had no link pointing straight at the goal, on pages that had a search
   * box. A label describes; a bar decides.
   */
  outputSchema: (ctx: GuideContext): ToolDef[] => {
    const refs = ctx.table.items.map((i) => i.ref as string);
    const str = (description?: string) => (description ? { type: 'string', description } : { type: 'string' });
    /**
     * Optional, said the only way OpenAI's strict mode allows it to be said:
     * a union with null, with the key still listed in `required`. "Leave it
     * out" is not expressible there — every property must be required — so a
     * model obeying the schema writes an explicit null, and `contract.ts`
     * reads null and absent as the same event.
     */
    const nullable = (description: string) => ({ type: ['string', 'null'], description });
    const fn = (
      name: string,
      description: string,
      required: readonly string[],
      properties: Record<string, unknown>,
    ): ToolDef => ({
      type: 'function',
      function: {
        name,
        description,
        strict: true,
        parameters: { type: 'object', additionalProperties: false, required: [...required], properties },
      },
    });

    return [
      fn('guide', '给出路标与这一页上能做的步骤。默认用这个。', ['previous_step', 'route', 'steps'], {
        // Answered before anything is planned, and required so it cannot be
        // skipped. The model is the only party that can compare this table
        // with the one it saw last time; asking it to say so out loud is
        // cheaper than describing, in prose, every situation it might be in.
        previous_step: {
          type: 'string',
          enum: ['first_plan', 'worked', 'no_change'],
          description:
            '先判断用户上一步的结果，再规划这一次。first_plan=这是第一次规划；worked=上一步生效了（页面跳走了，或元素表里多出了原先没有的控件）；no_change=元素表与上次相比没有实质变化，那一步没有生效，重复同一个控件不会有不同结果。',
        },
        route: {
          type: 'array',
          description: '粗路标序列，只写"在哪一页、要完成什么"。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['at', 'goal'],
            properties: { at: str(), goal: str() },
          },
        },
        steps: {
          type: 'array',
          // No `minItems`. Strict mode does not support it, and a schema
          // carrying an unsupported keyword is rejected outright — which
          // would cost the whole call, not just the constraint. The
          // requirement moves into the description, where it is advice.
          description: '这一页上能做的动作，按先后。至少一项，不能是空数组。',
          items: {
            type: 'object',
            additionalProperties: false,
            // `why` first, and the order is the whole point.
            //
            // Fields come out in the order the schema declares them — measured,
            // 4 of 4 draws emitted `ref → action → value → why` exactly. So a
            // schema that puts `ref` first makes the model commit to a control
            // before it has written a word about why, and the reasoning that
            // follows is a justification of a choice already made. Live, that
            // reads exactly as you would expect: 「选「Security and quality」会
            // 进入该仓库的安全与质量相关页面；**不过更贴合 CI 配置的是进入
            // Actions 或 .github 目录**」 — the right answer, in the same
            // sentence as the wrong click. Three rounds lost two or three hops
            // each to that shape, and one wrote 「不对，要看发布版本应点 Tags
            // 旁边的发布入口」 mid-`why` and clicked Tags anyway.
            //
            // browser-use overrides its own `required` by hand for this,
            // putting three reflection fields ahead of `action`
            // (`docs/research-dom-serialization-and-arrival.md` §3.1).
            required: ['why', 'ref', 'action', 'value', 'expect_after'],
            properties: {
              why: str('先写这一步为什么是这一步：你要去哪、这个控件为什么通向那里。写完再挑 ref。'),
              ref: { type: 'string', enum: refs, description: '元素表里的 ref，要和上面 why 说的那个控件一致。' },
              // No `observe`: it is the one action nothing can complete, so a
              // single-step plan carrying it freezes the thread. See `validate.ts`.
              action: { type: 'string', enum: ['click', 'input', 'select', 'toggle', 'scroll'] },
              value: nullable('只在 action 是 input 时给要输入的具体文字；其它情况填 null。'),
              // Optional and easy to leave out, which is the intent: §07 and
              // ADR 0007 both say a made-up expectation is worse than none.
              // But it has to be *expressible* — a schema that omits it does
              // not make the model humbler, it makes `judgeArrival` dead code
              // on this path, which is how the field went 0-for-42 live.
              expect_after: {
                type: ['object', 'null'],
                description: '只有确实有把握判断"做完这一步之后会出现什么"时才给，没有把握就填 null，不要编造。',
                additionalProperties: false,
                required: ['via_ref', 'must_contain'],
                properties: {
                  via_ref: str('元素表里那个会导致跳转或变化的 ref（通常与 ref 相同）。'),
                  must_contain: {
                    type: ['object', 'null'],
                    description: '落地后应当出现的控件形状，给不出就填 null。',
                    additionalProperties: false,
                    required: ['role', 'name'],
                    // `name` nullable for the same reason `value` is: strict
                    // mode has no way to say "optional", so a model that knows
                    // the landing control's role but not its text has to write
                    // something. A live draw wrote `{"role":"link","name":null}`
                    // and the parser refused the whole envelope over it.
                    properties: { role: str(), name: nullable('落地后那个控件的名字，说不准就填 null。') },
                  },
                },
              },
            },
          },
        },
      }),
      fn('clarify', '只在必须先得到用户回答才能继续时用：这一页上连一个能让用户更接近目标的入口都没有，或目标本身有歧义。搜索框、导航、菜单都算入口。', ['question', 'options'], {
        question: str(),
        options: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ref', 'label'],
            // No `ref` enum here, unlike `guide.steps[].ref`, and the reason is
            // arithmetic rather than principle: a second copy of the enum costs
            // roughly 4 tokens per element on *every* call — about a tenth of a
            // call on an 86-item page — and across the live runs `clarify`
            // named 13 refs, none of them outside the table. R-e rejects one if
            // it ever happens. Revisit when it does, not before.
            properties: { ref: str('元素表里的 ref。'), label: str() },
          },
        },
      }),
      fn('need_docs', '只在必须先读一份站内文档的正文才能决定下一步时用。', ['via_ref', 'query'], {
        via_ref: str('元素表里那个指向文档的链接的 ref。'),
        query: str('你需要从那份文档里读到什么。'),
      }),
      fn('done', '只在用户要做的事已经做完时用。走不下去不是做完——那是 clarify。', ['evidence', 'why'], {
        // Named before `why` is written, so the claim has to be classified
        // rather than narrated. Live runs produced `done` on goals that had
        // never started, and a free sentence could not tell that apart from a
        // real arrival.
        evidence: {
          type: 'string',
          enum: ['content_on_page', 'page_address', 'step_completed'],
          description:
            '凭什么说做完了。content_on_page=用户要的东西已经显示在这一页上；page_address=页面地址本身表明已经到了；step_completed=用户要执行的那一步已经生效。三者都不成立就不要用 done。',
        },
        why: str('说明你凭这一页上的什么判断已经做完。'),
      }),
    ];
  },

  /** The system message, verbatim — the same string `buildMessages` sends. */
  instructions: GUIDE_TOOL_SYSTEM,

  buildMessages: (ctx: GuideContext, nonce?: string): ChatMessage[] => [
    { role: 'system', content: GUIDE_TOOL_SYSTEM },
    { role: 'user', content: buildGuideUserMessage(ctx.goal, ctx.table, ctx.history, ctx.siteNotes, nonce) },
  ],

  /**
   * The endpoint reports which function the model called; that name is the
   * intent. `rawArgs` is what the model wrote, byte for byte, and the
   * provenance scanner runs on exactly that (see `parseToolContract`).
   */
  parseOutput: (toolName: string, rawArgs: string): ParseResult => parseToolContract(toolName, rawArgs),

  /**
   * The fallback for an endpoint that does not honour `tool_choice: 'required'`
   * and answers with prose instead of a call.
   *
   * That is not hypothetical: of the OpenAI-compatible endpoints whose docs
   * were checked, only OpenAI, Kimi and DeepSeek list `required` at all —
   * Qwen's parameter table has no `tool_choice` entry, Zhipu documents only
   * `auto`, and Gemini's compatibility layer says unlisted parameters are
   * silently ignored. On any of those the model may answer in text, and
   * without this the whole guide dies with 「端点没有返回任何工具调用」.
   *
   * Producing free-text envelopes was deleted; *reading* one never was, and
   * `contract.ts` still does it for the QA path. So the cost of this is one
   * function call on a path that is already failing.
   */
  parseTextOutput: (raw: string): ParseResult => parseContract(raw),

  /**
   * Takes the table rather than a whole `GuideContext`: R-a…R-e judge an
   * envelope against the page it was written for, and neither the goal nor
   * the history is an input to any of them. Handing it a context would mean
   * `machine.ts` assembling two fields nothing reads.
   */
  validate: (envelope: Envelope | UnknownIntentEnvelope, table: PromptTable): ValidateResult =>
    validateEnvelope(envelope, table),
} as const;
