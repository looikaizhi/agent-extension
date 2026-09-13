import { shapeMismatch } from '@/agent/envelope/contract';
import { samePlace } from '@/agent/thread/place';
import type { ThreadState } from '@/agent/thread/thread';
import { present } from '@/agent/thread/transitions';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { hostOf, sameHost } from '@/core/security/link-safety';
import type { GuideStep, UserAction } from '@/shared/protocol';
import type { GuideExpectAfter, GuideRouteHop, Never, Ref } from '@/shared/types';
import type { GuideContext } from '../agent';
import type { GuideIntentModule } from '../intent-module';
import { fn, nullable, str } from '../tool-schema';

/**
 * The actions a guide step may ask of the user: every `UserAction` except
 * `observe`, which nothing can complete. The tool schema offers exactly these
 * to the model and R-d refuses anything else — this is the one list both read,
 * so the two cannot drift into offering one set and accepting another.
 */
export const GUIDE_STEP_ACTIONS = ['click', 'input', 'select', 'toggle', 'scroll'] as const satisfies readonly UserAction[];

/** `satisfies` above only proves a subset. This proves the rest: an action
 *  added to `UserAction` and not listed here does not compile, rather than
 *  silently never being offered to the model. */
type _EveryActionButObserve = Never<Exclude<Exclude<UserAction, 'observe'>, (typeof GUIDE_STEP_ACTIONS)[number]>>;

export interface GuideStepIntent {
  ref: Ref;
  /**
   * What to type, for an `input` step. Composed by the model, never by us:
   * turning 「微软的开源 AI 工具」 into a query a search box will actually
   * answer (`org:microsoft ai`) is judgement about the site and the goal
   * together, which is the thing the model is here for — a keyword extractor
   * on our side would be guessing at both.
   *
   * Optional, because some inputs only the user can fill (an instance name, a
   * personal note). Absent means the card says where to type and stops there.
   * Displayed, never typed: the keyboard stays the user's («只指路，不开车»).
   */
  value?: string;
  action: string;
  why: string;
  expect_after?: GuideExpectAfter;
}

/** The model's own reading of what the last step accomplished. Required by
 *  the schema, so a well-formed `guide` always carries one. */
export const GUIDE_PREVIOUS_STEP = ['first_plan', 'worked', 'no_change'] as const;

/** What the model says the user's previous step accomplished, decided before
 *  it plans this one. `first_plan` on the opening call; `worked` when the page
 *  moved or new controls appeared; `no_change` when neither did. */
export type PreviousStep = (typeof GUIDE_PREVIOUS_STEP)[number];

export interface GuideEnvelope {
  intent: 'guide';
  /** Absent when the model's value is not one of `GUIDE_PREVIOUS_STEP`:
   *  recognition drops it rather than refusing the envelope. */
  previous_step?: PreviousStep;
  route: GuideRouteHop[];
  steps: GuideStepIntent[];
}

/**
 * R-f's subject: controls whose whole purpose is to receive a value.
 *
 * `combobox` is here because HTML-AAM maps a plain `<select>` onto it as well
 * as a text-entry combobox (`resolveRole` delegates to dom-accessibility-api's
 * implementation of that mapping), and both are covered by the same rule — a
 * click that never leads to a value being put in is a step that cannot move
 * anything either way. That is also why the remedy below accepts `select`
 * alongside `input`.
 */
const VALUE_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/** R-f's remedy: the actions that actually put a value into one of the above. */
const VALUE_ENTRY_ACTIONS = new Set(['input', 'select']);

/**
 * R-d's membership set: the actions a model-proposed step may carry —
 * `GUIDE_STEP_ACTIONS` above, the same list the tool schema offers. A
 * `Set<string>` so `.has` accepts the model's raw, unnarrowed `string` without
 * a cast at the call site.
 *
 * `observe` is not in it. It is still a legal action for a step *we* author —
 * the QA path builds one directly — but it is the only action with no
 * completion signal (`content.ts`'s `ADVANCING_ACTIONS`), so a single-step
 * plan carrying it froze the thread: the reducer noticed nothing happened,
 * said so once, and never re-planned. Measured across 80 live actions, the
 * model reached for it 7 times — 4 of them saying, in the step's own `why`,
 * that the goal was already visible on the page. That is a `done`, and taking
 * `observe` away leaves the three tools that all have an exit.
 */
const STEP_ACTIONS = new Set<string>(GUIDE_STEP_ACTIONS);

/**
 * Structural only — same discipline as `recognizeClarify`'s empty `options` or
 * `recognizeExplain`'s empty `refs` (`envelope/contract.ts`). `route` and `steps`
 * may both be empty arrays, `action` is accepted as any string, and no `ref`
 * is checked against any table — recognition has no table to check it
 * against. Those are R-a…R-f (design doc §5.6): R-a/R-e are the shared
 * validator's, R-b/R-d/R-f this module's `violation`. A `guide` with zero
 * `steps` is recognised here and refused there, as a violation — never a
 * `clarify`.
 */
function recognizeGuide(obj: Record<string, unknown>): GuideEnvelope | null {
  if (!Array.isArray(obj.route)) return null;
  const route: GuideRouteHop[] = [];
  for (const raw of obj.route) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== 'string' || typeof r.goal !== 'string') return null;
    route.push({ at: r.at, goal: r.goal });
  }

  if (!Array.isArray(obj.steps)) return null;
  const steps: GuideStepIntent[] = [];
  for (const raw of obj.steps) {
    const step = recognizeGuideStep(raw);
    if (!step) return null;
    steps.push(step);
  }

  // Carried when present and recognisable, dropped otherwise. A wrong value
  // here is not worth refusing a whole plan over: nothing downstream decides
  // anything on it — it exists to make the model look at the page before it
  // plans, and it earns its place in the trace either way.
  const previous = (GUIDE_PREVIOUS_STEP as readonly string[]).includes(obj.previous_step as string)
    ? (obj.previous_step as PreviousStep)
    : undefined;

  return { intent: 'guide', ...(previous ? { previous_step: previous } : {}), route, steps };
}

function recognizeGuideStep(raw: unknown): GuideStepIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.ref !== 'string' || typeof s.action !== 'string' || typeof s.why !== 'string') return null;
  const step: GuideStepIntent = { ref: s.ref as Ref, action: s.action, why: s.why };
  // Absent and `null` are the same event, the same way `expect_after` below
  // already treats them — and now they have to be, because a schema that is
  // valid under OpenAI's strict mode has no way to say "optional" except a
  // union with null, so a model obeying it writes `"value": null` for every
  // step that is not an `input`. A wrong *type* is still a malformed envelope,
  // never something to coerce into shape.
  if (s.value !== undefined && s.value !== null) {
    if (typeof s.value !== 'string') return null;
    step.value = s.value;
  }

  // `expect_after` absent or `null` both mean "declined to give one" — same
  // normalization `recognizeExplain` already applies to `refs` (see slice
  // 16a in contract.spec.ts): a model that has no arrival check to offer and
  // a model that omits the key entirely are the same event, not two.
  if (s.expect_after === undefined || s.expect_after === null) return step;
  if (typeof s.expect_after !== 'object') return null;
  const ea = s.expect_after as Record<string, unknown>;
  if (typeof ea.via_ref !== 'string') return null;
  const expectAfter: GuideExpectAfter = { via_ref: ea.via_ref as Ref };

  if (ea.must_contain !== undefined && ea.must_contain !== null) {
    if (typeof ea.must_contain !== 'object') return null;
    const mc = ea.must_contain as Record<string, unknown>;
    // A null `role` drops the whole check, exactly as a null `name` drops the
    // name half below — same argument, and it was an omission that only the
    // name half got it. Strict mode forces both properties to be present, so a
    // model that cannot predict the landing shape has no way to say so except
    // by writing `null`; refusing the envelope over it threw away route,
    // steps, ref and action that were all perfectly good. Measured across two
    // live runs, this single shape was 9 of 12 and 13 of 20 parse failures —
    // and every one of them cost a whole round, because a rejected draw leaves
    // the previous, already-shown plan on screen.
    //
    // Dropped rather than kept half-built: `judgeArrival` needs a role to have
    // anything to look for, so `{name}` alone is not a weaker check, it is no
    // check wearing one's clothes.
    if (mc.role === null) {
      step.expect_after = expectAfter;
      return step;
    }
    if (typeof mc.role !== 'string') return null;
    // A null `name` is "no constraint on the name", read the same way `value`
    // and `expect_after` already read theirs. Strict mode forces every property
    // to be present, so a model that can name the landing *role* but not its
    // text has no other way to say so — and one live draw did exactly that,
    // `{"role":"link","name":null}`, which the old check refused, throwing away
    // an otherwise perfectly good envelope over the one field it was least
    // sure of.
    if (mc.name !== undefined && mc.name !== null && typeof mc.name !== 'string') return null;
    expectAfter.must_contain =
      typeof mc.name === 'string' ? { role: mc.role, name: mc.name } : { role: mc.role };
  }
  step.expect_after = expectAfter;
  return step;
}

/**
 * Why a `guide` was not recognised, down to the field that is wrong.
 *
 * The single sentence this replaced named only S1's three intents — long after
 * `guide`/`need_docs`/`done` were recognised too — and reported a `guide`
 * envelope missing one `why` with the same words as an envelope of an entirely
 * unknown kind. Live consequence: a github.com journey died at hop 0, and the
 * message sent the investigation looking for a routing bug that did not exist.
 */
function explainGuide(obj: Record<string, unknown>): string {
  const missing = (path: string, field: string) => `guide 信封的 ${path} 缺少 ${field} 字段（或类型不对）`;
  if (!Array.isArray(obj.route)) return missing('顶层', 'route（必须是数组）');
  for (const [i, hop] of obj.route.entries()) {
    if (typeof hop !== 'object' || hop === null) return missing(`route[${i}]`, '对象结构');
    const h = hop as Record<string, unknown>;
    for (const f of ['at', 'goal']) if (typeof h[f] !== 'string') return missing(`route[${i}]`, f);
  }
  if (!Array.isArray(obj.steps)) return missing('顶层', 'steps（必须是数组）');
  for (const [i, raw] of obj.steps.entries()) {
    if (typeof raw !== 'object' || raw === null) return missing(`steps[${i}]`, '对象结构');
    const st = raw as Record<string, unknown>;
    for (const f of ['ref', 'action', 'why']) if (typeof st[f] !== 'string') return missing(`steps[${i}]`, f);
    if (st.value !== undefined && st.value !== null && typeof st.value !== 'string')
      return missing(`steps[${i}]`, 'value（有的话必须是字符串）');
    if (st.expect_after !== undefined && st.expect_after !== null) {
      if (typeof st.expect_after !== 'object') return missing(`steps[${i}].expect_after`, '对象结构');
      if (typeof (st.expect_after as Record<string, unknown>).via_ref !== 'string')
        return missing(`steps[${i}].expect_after`, 'via_ref');
    }
  }
  return shapeMismatch('guide', 'route + steps');
}

/**
 * §5.5's mapping, model envelope → runtime `GuideStep` (`src/shared/protocol.ts`).
 * Only ever called after the guide agent's `validate` has returned `ok` for the
 * envelope `stepEnvelope` came from (Seam) — every field this function
 * reads has already been checked to exist on `table` and not be `sensitive`
 * (R-a/R-e), and `stepEnvelope.action` has already been checked to be a
 * member of `UserAction` (R-d). That is why there is no `actionForRole`
 * fallback branch here: adding one would only be defending against input
 * this function's sole legitimate caller can never hand it — see the
 * "unreachable" test in validate.spec.ts, which proves R-d already turns
 * that input into a `violation` before anyone gets this far.
 */
export function toGuideStep(stepEnvelope: GuideStepIntent, table: PromptTable): GuideStep {
  // Non-null: guaranteed by R-a, which the caller has already run.
  const item = table.items.find((i) => i.ref === stepEnvelope.ref)!;
  return {
    ref: item.ref,
    descriptor: descriptorOf(item),
    expectedUserAction: stepEnvelope.action as UserAction,
    title: item.name || item.role,
    detail: stepEnvelope.why,
    ...(stepEnvelope.value !== undefined ? { value: stepEnvelope.value } : {}),
  };
}

/**
 * guide, as the guide agent answers with it — an `Output`: the route ahead,
 * and the steps the user can take on this page.
 */
export const guide: GuideIntentModule<GuideEnvelope> = {
  intent: 'guide',
  // `steps[].ref` is an enum of this snapshot's refs, rebuilt per call. It
  // costs 4–6 tokens per element (each ref then travels twice, once in the
  // table and once here, so the price grows with the page) and it was dropped
  // once on the argument that it does not deliver what it promises: across
  // 110 calls with `strict: true` the model still produced an empty ref, a
  // ref that was a sentence of prose, and a ref for an element not on the
  // page.
  //
  // It is back, but the case for it is thinner than the case that removed it,
  // and the honest version is worth stating: a capture without it produced a
  // `guide` with no `steps` in 4 of 16 draws against 1 of 16 with it, which
  // looked decisive until a third capture — enum present — produced 5 of 16.
  // Sixteen draws cannot separate those. What the enum is *known* to do is
  // hold the ref inside the table: the last live run had 0 violations in 79
  // calls. R-a runs anyway, because 0 in 79 is not a guarantee.
  tool: (ctx: GuideContext) => {
    const refs = ctx.table.items.map((i) => i.ref as string);
    return fn('guide', '给出路标与这一页上能做的步骤。默认用这个。', ['previous_step', 'route', 'steps'], {
      // Answered before anything is planned, and required so it cannot be
      // skipped. The model is the only party that can compare this table
      // with the one it saw last time; asking it to say so out loud is
      // cheaper than describing, in prose, every situation it might be in.
      previous_step: {
        type: 'string',
        enum: [...GUIDE_PREVIOUS_STEP],
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
            // single-step plan carrying it freezes the thread. See `STEP_ACTIONS`.
            action: { type: 'string', enum: [...GUIDE_STEP_ACTIONS] },
            value: nullable('只在 action 是 input 时给要输入的具体文字；其它情况填 null。'),
            // Optional and easy to leave out, which is the intent: a made-up
            // expectation is worse than none.
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
    });
  },
  // The "离目标更近一点就够了" clause, and the narrower `clarify` trigger that
  // goes with it (`clarify.ts`), come from the first live multi-page run: 8 of
  // 12 samples came back `clarify` and only 2 came back `guide`. The model was
  // reading "当前页面上找不到任何合理起点" literally and correctly — on a first
  // page, the control that finishes the job genuinely is not there. But it is
  // not the one this page is being asked about: `steps` is scoped to the
  // current page by design, and every page after this one gets its own call
  // with its own table. So the instruction had to say what a good first step
  // *is*, positively — telling the model to clarify less would only have made
  // `clarify` the more available word.
  policy: `- **guide**：只要这一页上还有一个能让用户离目标更近的控件，就用它。大多数目标要跨好几个页面才能完成，所以这一页上正确的一步通常只是"离目标更近一点"，而不是"直接完成目标"——导航项、链接、搜索框、菜单、按钮都算入口，在 why 里说明它通向哪里。`,
  recognize: recognizeGuide,
  explain: explainGuide,
  // `expect_after.via_ref` is claimed alongside `steps[i].ref` on purpose: it
  // is "同一类需要核对的字段" as the step's own `ref`, so it goes through the
  // identical R-a/R-e check rather than a second bespoke one. `route` is not
  // claimed at all: it is the one field the model is allowed to invent
  // (design doc §1.3), and nothing in it can point at anything on the page.
  claimedRefs: (envelope) => envelope.steps.flatMap((s) => (s.expect_after ? [s.ref, s.expect_after.via_ref] : [s.ref])),
  violation: (envelope, table) => {
    // R-b, front half only: "至少一步" is a pure structural check. "第一步绑定
    // 成功" needs a real bind attempt against the live DOM — that is CL-2, on
    // `bind_result`.
    if (envelope.steps.length === 0) return 'guide.steps 为空：R-b 要求至少一步';

    // R-d: `action` must be one the schema offers (`STEP_ACTIONS`). A model handing back an
    // enum-adjacent string (English interfaces commonly produce `'tap'` /
    // `'press'`) is never silently mapped onto the nearest value — that would
    // hide "the model didn't actually commit to a clear action" from the user.
    for (const step of envelope.steps) {
      if (!STEP_ACTIONS.has(step.action)) return `action「${step.action}」不在 UserAction 枚举内`;
    }

    // R-f: a lone `click` on a control that exists to take a value.
    //
    // Clicking a text field cannot move a page — it is a no-op by construction —
    // and a plan whose every step is a no-op leaves the reducer with one replan
    // and nothing else. Two of 21 live journeys died exactly there, and a third
    // stalled: all three wrote 「在搜索框输入 …」 in the step's own `why` and
    // then emitted the click without the `input` that sentence described. The
    // reasoning was right and the plan was one step short, which is precisely
    // the shape a repair round can fix.
    //
    // Order does not matter, only membership: the five journeys that *worked*
    // gave `input` first and `click` second (type the repo name, then click the
    // suggestion the page has by then grown). A rule that demanded the `input`
    // come *after* would have failed all five.
    //
    // Runs after the shared R-a, so every ref named here is already known to be
    // in `table`.
    const roleOf = new Map<Ref, string>(table.items.map((i) => [i.ref, i.role]));
    const stranded = envelope.steps.find(
      (s) =>
        s.action === 'click' &&
        VALUE_ENTRY_ROLES.has(roleOf.get(s.ref) ?? '') &&
        !envelope.steps.some((other) => other.ref === s.ref && VALUE_ENTRY_ACTIONS.has(other.action)),
    );
    if (stranded) {
      return (
        `ref「${stranded.ref}」是一个用来填内容的控件，只点它不会有任何反应：` +
        '同一份计划里要么再给它一步 input/select，要么改指别的控件'
      );
    }
    return null;
  },
  rationales: (envelope) => envelope.steps.map((s) => s.why),
  consequence: (state, envelope) => {
    // R-b already guarantees `steps.length > 0` (`violation`, above), so
    // `present` always has a step 0 to point at.
    const steps = envelope.steps.map((s) => toGuideStep(s, state.table));

    // The backstop, not the main defence: a model told where the user has
    // already been should stop on its own (the history in its user message), and
    // this catches the times it does not. Same two-independent-layers shape as
    // `pageMoved`'s content-script check and its host-side re-check.
    //
    // Scoped to a step that was *just* confirmed. Repeating a control is
    // legitimate in general — the same field can be filled twice — but a step
    // whose completion has already been proven has no reason to be redone, and
    // proposing it again is the loop that made five live GitHub rounds all
    // stall on their first step.
    //
    // Matched on title *and* where that control last led.
    //
    // Title alone cannot tell the two apart, and they are opposites. The
    // search box that carried the user to `/repo` is still in the nav bar of
    // `/repo`; proposing it there to search for something else is ordinary
    // use. Proposing it while the user is still on the page it already took
    // them from is the loop — five live GitHub rounds all stalled on exactly
    // that, re-proposing the control they had just finished with.
    //
    // `landedAt` is what separates them: it records where the step actually
    // got to, not merely what was pressed. When it is absent — an older entry,
    // or a step whose arrival was never observed — the check falls back to
    // title alone and stops. The costs are not symmetric: a misfire tells the
    // user "looks like you're there" and they ask again, while a missed cycle
    // burns the whole 12-call quota.
    //
    // Scanned across the whole history rather than the last entry, because the
    // loop that shows up is a *cycle*: 搜索按钮 → 搜索输入框 → 搜索按钮 reads
    // as two different titles in a row and slips past any check on the
    // previous step alone.
    const seen = state.history.find(
      (h) =>
        h.outcome === 'confirmed' &&
        h.title === steps[0]!.title &&
        // Did that step actually take the user anywhere? `landedAt` is where
        // it got to; `h.url` is where it was proposed. Equal means it moved
        // nobody, so proposing it again is the loop. Different means it did
        // carry the user forward, and the same control appearing later — the
        // search box still sitting in the nav bar of the page it led to — is
        // ordinary reuse, not a cycle.
        (h.landedAt === undefined || samePlace(h.landedAt, h.url)),
    );
    if (seen) {
      // Terminal, exactly as the model's own `done` is (`done.ts`).
      // `background.ts`'s done branch clears the overlay on the strength of
      // that — a finished thread has emptied its steps, so there is nothing
      // left to point at. That held for the model's `done` and
      // never for this branch: the panel said 「引导在原地打转，已经停下」 while
      // the thread stayed active with its steps intact, went on replanning, and
      // went on spending quota. Three live journeys did exactly that, each
      // taking one more hop after being told it had stopped.
      //
      // An ending of its own, not the model's: this asserts that the guide
      // cannot go on, never that the goal was reached. How many steps were
      // confirmed is the Run record's other half, counted from history — and
      // `seen` requires a `confirmed` entry to match, so it is never none.
      return {
        state: { ...state, ending: 'loop_backstop', steps: [], cursor: 0 },
        effects: [
          {
            kind: 'done',
            why: `模型又一次指向已经用过的「${seen.title}」，引导没有再往前走。`,
            ending: 'loop_backstop',
          },
        ],
      };
    }
    const next: ThreadState = {
      ...state,
      route: envelope.route,
      steps,
      cursor: 0,
      outcomes: steps.map(() => undefined),
      // Recorded here rather than at the render site: `history` has to survive
      // the wholesale replacement of `steps`/`cursor`/`outcomes` happening on
      // the very same line, and this is the only place that replacement occurs.
      history: [...state.history, { title: steps[0]!.title, url: state.table.url, outcome: 'unknown' }],
      // Kept on the thread, not on the `GuideStep`: the renderer has no use
      // for a prediction, the host does — it is what the next breakpoint
      // checks the arrived page against.
      ...(envelope.steps[0]!.expect_after ? { expect: envelope.steps[0]!.expect_after } : { expect: undefined }),
    };
    // P-2: if this step leaves the site, the destination gets said out loud
    // before the user commits to it. The address comes from the *table* — the
    // page vouching for its own link — never from the model, which outputs
    // refs and never URLs (S-07).
    const target = state.table.items.find((i) => i.ref === steps[0]!.ref)?.href;
    if (target && !sameHost(state.table.url, target)) {
      const to = hostOf(target);
      // The step stays loaded behind the card: answering `true` presents it
      // without another model call, answering `false` costs nothing at all.
      if (to) return { state: { ...next, pendingCrossSite: to }, effects: [{ kind: 'requestCrossSiteConfirm', from: hostOf(state.table.url) ?? state.table.url, to }] };
    }
    return { state: next, effects: [present(next, 0)] };
  },
};
