import { shapeMismatch } from '@/agent/envelope/contract';
import type { ThreadState } from '@/agent/thread/thread';
import { present } from '@/agent/thread/transitions';
import type { PromptTable } from '@/core/extractor/types';
import { descriptorOf } from '@/core/descriptor/bind';
import { hostOf, sameHost, structuralRedFlags, type RedFlag } from '@/core/security/link-safety';
import type { GuideStep, UserAction } from '@/shared/protocol';
import type { GuideExpectAfter, GuideRouteHop, Never, Ref } from '@/shared/types';
import type { GuideContext } from '../agent';
import type { GuideIntentModule } from '../intent-module';
import { fn, nullable, str } from '../tool-schema';

/**
 * The actions a step may ask of the user: every `UserAction` except `observe`,
 * which nothing can complete. The tool schema offers exactly these to the
 * model and R-d refuses anything else — this is the one list both read, so the
 * two cannot drift into offering one set and accepting another.
 */
export const GUIDE_STEP_ACTIONS = ['click', 'input', 'select', 'toggle', 'scroll'] as const satisfies readonly UserAction[];

/** `satisfies` above only proves a subset. This proves the rest: an action
 *  added to `UserAction` and not listed here does not compile, rather than
 *  silently never being offered to the model. */
type _EveryActionButObserve = Never<Exclude<Exclude<UserAction, 'observe'>, (typeof GUIDE_STEP_ACTIONS)[number]>>;

/** The model's own reading of what the last step accomplished. Required by
 *  the schema, so a well-formed `point` always carries one. */
export const GUIDE_PREVIOUS_STEP = ['first_plan', 'worked', 'no_change'] as const;

/** What the model says the user's previous step accomplished, decided before
 *  it points at this one. `first_plan` on the opening call; `worked` when the
 *  page moved or new controls appeared; `no_change` when neither did. */
export type PreviousStep = (typeof GUIDE_PREVIOUS_STEP)[number];

/**
 * One step, and nothing after it (CONTEXT.md `Agent`: one step at a time).
 *
 * A plan of several steps is planned against a page its later steps will
 * never see — the next table arrives only after the first step is taken — and
 * the one path that walked such a plan, advancing when a settle window
 * closed, moved on without recording what happened to the step it left.
 */
export interface PointEnvelope {
  intent: 'point';
  /** Absent when the model's value is not one of `GUIDE_PREVIOUS_STEP`:
   *  recognition drops it rather than refusing the envelope. */
  previous_step?: PreviousStep;
  /** Waypoints ahead (CONTEXT.md `Route`). Shown, never walked. */
  route: GuideRouteHop[];
  why: string;
  ref: Ref;
  action: string;
  /**
   * What to type, for an `input` step. Composed by the model, never by us:
   * turning 「微软的开源 AI 工具」 into a query a search box will actually
   * answer (`org:microsoft ai`) is judgement about the site and the goal
   * together, which is the thing the model is here for.
   *
   * Optional, because some inputs only the user can fill (an instance name, a
   * personal note). Absent means the card says where to type and stops there.
   * Displayed, never typed: the keyboard stays the user's («只指路，不开车»).
   */
  value?: string;
  expect_after?: GuideExpectAfter;
}

/**
 * The subject of the value-entry rule: controls whose whole purpose is to
 * receive a value.
 *
 * `combobox` is here because HTML-AAM maps a plain `<select>` onto it as well
 * as a text-entry combobox, and both are covered by the same rule — a click
 * that never puts a value in cannot move anything either way. That is also
 * why the remedy accepts `select` alongside `input`.
 */
const VALUE_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'combobox']);

/**
 * Each structural red flag in a sentence the model can act on.
 *
 * Said as a fact about the address rather than as an accusation: the checks
 * answer "what shape is this URL", never "who owns it" (P-1). The model's way
 * out is named too — a refusal with no alternative is one the model can only
 * satisfy by guessing again.
 */
/**
 * 指路这条路径上只问这两条：它们的共同点是**伪装**——地址在屏幕上看着像一个地方，
 * 实际去的是另一个地方。跨站确认卡恰好挡不住这一类，因为它能展示的就是那个看着没问题的主机名。
 *
 * 另外两条留给 `fetchDoc`：`private_network` 担心的是**我们**去够用户的内网，而指路时用户本来
 * 就站在那儿（自己 `localhost:3000` 上的应用，每个链接都是「内网」）；`scheme` 会误伤 `mailto:`，
 * 而指着它说「点这里给支持发邮件」是正当的。
 */
const DISGUISE_FLAGS: ReadonlySet<RedFlag> = new Set<RedFlag>(['userinfo', 'homograph']);

const RED_FLAG_WHY: Record<RedFlag, string> = {
  userinfo: '地址里带着 `用户名@` 这一段，`@` 前面看着像官方站，真正要去的是 `@` 后面那个主机',
  scheme: '它不是 http/https，引导不会把用户带到这样的地址上',
  private_network: '它指向本机或内网，那不是这一页的用户能去的地方',
  homograph: '主机名里有非 ASCII 字符或是 `xn--` 编码，屏幕上可能和某个常见域名长得一模一样，我们读不准它到底是谁',
};

/**
 * R-d's membership set — `GUIDE_STEP_ACTIONS` above, as a `Set<string>` so
 * `.has` accepts the model's raw, unnarrowed `string` without a cast.
 *
 * `observe` is not in it. It is still a legal action for a step *we* author —
 * the outline of what backs an answer is built with it (`shared/outline.ts`)
 * — but it is the only action with no
 * completion signal, so a step carrying it froze the thread. Measured across
 * 80 live actions, the model reached for it 7 times — 4 of them saying, in the
 * step's own `why`, that the goal was already visible on the page. That is a
 * `done`.
 */
const STEP_ACTIONS = new Set<string>(GUIDE_STEP_ACTIONS);

/**
 * Structural only. `action` is accepted as any string and no `ref` is checked
 * against any table — recognition has no table to check it against. Those are
 * R-a/R-e (the shared validator's) and R-d plus the value-entry rule (this
 * module's `violation`).
 */
function recognizePoint(obj: Record<string, unknown>): PointEnvelope | null {
  if (!Array.isArray(obj.route)) return null;
  const route: GuideRouteHop[] = [];
  for (const raw of obj.route) {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== 'string' || typeof r.goal !== 'string') return null;
    route.push({ at: r.at, goal: r.goal });
  }
  if (typeof obj.ref !== 'string' || typeof obj.action !== 'string' || typeof obj.why !== 'string') return null;

  // Carried when present and recognisable, dropped otherwise. A wrong value
  // here is not worth refusing a step over: nothing downstream decides
  // anything on it — it exists to make the model look at the page before it
  // points, and it earns its place in the trace either way.
  const previous = (GUIDE_PREVIOUS_STEP as readonly string[]).includes(obj.previous_step as string)
    ? (obj.previous_step as PreviousStep)
    : undefined;
  const envelope: PointEnvelope = {
    intent: 'point',
    ...(previous ? { previous_step: previous } : {}),
    route,
    why: obj.why,
    ref: obj.ref as Ref,
    action: obj.action,
  };

  // Absent and `null` are the same event: a schema valid under OpenAI's strict
  // mode has no way to say "optional" except a union with null, so a model
  // obeying it writes `"value": null` for every step that is not an `input`. A
  // wrong *type* is still a malformed envelope, never something to coerce.
  if (obj.value !== undefined && obj.value !== null) {
    if (typeof obj.value !== 'string') return null;
    envelope.value = obj.value;
  }

  if (obj.expect_after === undefined || obj.expect_after === null) return envelope;
  if (typeof obj.expect_after !== 'object') return null;
  const ea = obj.expect_after as Record<string, unknown>;
  if (typeof ea.via_ref !== 'string') return null;
  const expectAfter: GuideExpectAfter = { via_ref: ea.via_ref as Ref };

  if (ea.must_contain !== undefined && ea.must_contain !== null) {
    if (typeof ea.must_contain !== 'object') return null;
    const mc = ea.must_contain as Record<string, unknown>;
    // A null `role` drops the whole check, exactly as a null `name` drops the
    // name half below. Strict mode forces both properties to be present, so a
    // model that cannot predict the landing shape has no way to say so except
    // by writing `null`; refusing the envelope over it threw away a perfectly
    // good step. Measured across two live runs, this single shape was 9 of 12
    // and 13 of 20 parse failures.
    //
    // Dropped rather than kept half-built: `judgeArrival` needs a role to have
    // anything to look for, so `{name}` alone is no check wearing one's clothes.
    if (mc.role === null) {
      envelope.expect_after = expectAfter;
      return envelope;
    }
    if (typeof mc.role !== 'string') return null;
    // A null `name` is "no constraint on the name": a model that can name the
    // landing *role* but not its text has no other way to say so. One live
    // draw did exactly that, `{"role":"link","name":null}`.
    if (mc.name !== undefined && mc.name !== null && typeof mc.name !== 'string') return null;
    expectAfter.must_contain = typeof mc.name === 'string' ? { role: mc.role, name: mc.name } : { role: mc.role };
  }
  envelope.expect_after = expectAfter;
  return envelope;
}

/**
 * Why a `point` was not recognised, down to the field that is wrong. A single
 * sentence for every shape once sent a live investigation looking for a
 * routing bug that did not exist, over one missing `why`.
 */
function explainPoint(obj: Record<string, unknown>): string {
  const missing = (field: string) => `point 信封缺少 ${field} 字段（或类型不对）`;
  if (!Array.isArray(obj.route)) return missing('route（必须是数组）');
  for (const [i, hop] of obj.route.entries()) {
    if (typeof hop !== 'object' || hop === null) return missing(`route[${i}] 的对象结构`);
    const h = hop as Record<string, unknown>;
    for (const f of ['at', 'goal']) if (typeof h[f] !== 'string') return missing(`route[${i}].${f}`);
  }
  for (const f of ['why', 'ref', 'action']) if (typeof obj[f] !== 'string') return missing(f);
  if (obj.value !== undefined && obj.value !== null && typeof obj.value !== 'string') return missing('value（有的话必须是字符串）');
  if (obj.expect_after !== undefined && obj.expect_after !== null) {
    if (typeof obj.expect_after !== 'object') return missing('expect_after 的对象结构');
    if (typeof (obj.expect_after as Record<string, unknown>).via_ref !== 'string') return missing('expect_after.via_ref');
  }
  return shapeMismatch('point', 'route + why + ref + action');
}

/**
 * Model envelope → runtime `GuideStep` (`src/shared/protocol.ts`). Only ever
 * called after the guide agent's `validate` has returned `ok` — the ref is on
 * the table and not sensitive (R-a/R-e), and the action is one the schema
 * offers (R-d) — which is why there is no fallback branch here.
 */
export function toGuideStep(envelope: Pick<PointEnvelope, 'ref' | 'action' | 'why' | 'value'>, table: PromptTable): GuideStep {
  // Non-null: guaranteed by R-a, which the caller has already run.
  const item = table.items.find((i) => i.ref === envelope.ref)!;
  return {
    ref: item.ref,
    descriptor: descriptorOf(item),
    expectedUserAction: envelope.action as UserAction,
    title: item.name || item.role,
    detail: envelope.why,
    ...(envelope.value !== undefined ? { value: envelope.value } : {}),
  };
}

/**
 * point, as the guide agent answers with it — an `Output`: the route ahead,
 * and the one step the user takes next.
 */
export const point: GuideIntentModule<PointEnvelope> = {
  intent: 'point',
  kind: 'output',
  // `ref` is an enum of this snapshot's refs, rebuilt per call. It costs 4–6
  // tokens per element (each ref then travels twice, once in the table and
  // once here). What the enum is *known* to do is hold the ref inside the
  // table: the last live run with it had 0 violations in 79 calls. R-a runs
  // anyway, because 0 in 79 is not a guarantee.
  tool: (ctx: GuideContext) => {
    const refs = ctx.table.items.map((i) => i.ref as string);
    // `why` before `ref`, and the order is the whole point. Fields come out in
    // the order the schema declares them — measured, 4 of 4 draws — so a
    // schema that puts `ref` first makes the model commit to a control before
    // it has written a word about why, and the reasoning that follows
    // justifies a choice already made. Live, that read 「选「Security and
    // quality」…；不过更贴合 CI 配置的是进入 Actions」: the right answer in the
    // same sentence as the wrong click.
    return fn('point', '指出用户在这一页上要做的下一步。默认用这个。', ['previous_step', 'route', 'why', 'ref', 'action', 'value', 'expect_after'], {
      // Answered before anything is chosen, and required so it cannot be
      // skipped. The model is the only party that can compare this table
      // with the one it saw last time.
      previous_step: {
        type: 'string',
        enum: [...GUIDE_PREVIOUS_STEP],
        description:
          '先判断用户上一步的结果，再指这一步。first_plan=这是这一趟的第一步；worked=上一步生效了（页面跳走了，或元素表里多出了原先没有的控件）；no_change=元素表与上次相比没有实质变化。',
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
      why: str('先写这一步为什么是这一步：你要去哪、这个控件为什么通向那里。写完再挑 ref。'),
      ref: { type: 'string', enum: refs, description: '元素表里的 ref，要和上面 why 说的那个控件一致。' },
      // No `observe`: it is the one action nothing can complete. See `STEP_ACTIONS`.
      action: { type: 'string', enum: [...GUIDE_STEP_ACTIONS] },
      value: nullable('只在 action 是 input 时给要输入的具体文字；其它情况填 null。'),
      // Optional and easy to leave out, which is the intent: a made-up
      // expectation is worse than none. But it has to be *expressible* — a
      // schema that omits it makes `judgeArrival` dead code on this path,
      // which is how the field went 0-for-42 live.
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
            properties: { role: str(), name: nullable('落地后那个控件的名字，说不准就填 null。') },
          },
        },
      },
    });
  },
  // The "离目标更近一点就够了" clause comes from the first live multi-page run:
  // 8 of 12 samples came back asking and only 2 pointed. On a first page, the
  // control that finishes the job genuinely is not there — but every page after
  // this one gets its own call with its own table, so the instruction says what
  // a good step *is*, positively.
  policy: `- **point**：只要这一页上还有一个能让用户离目标更近的控件，就用它，指出用户接下来要做的**这一步**。大多数目标要跨好几个页面才能完成，所以这一页上正确的一步通常只是"离目标更近一点"，而不是"直接完成目标"——导航项、链接、搜索框、菜单、按钮都算入口，在 why 里说明它通向哪里。`,
  recognize: recognizePoint,
  explain: explainPoint,
  // `expect_after.via_ref` is claimed alongside `ref` on purpose: it is the
  // same kind of field, so it goes through the identical R-a/R-e check. `route`
  // is not claimed at all: it is the one field the model is allowed to invent,
  // and nothing in it can point at anything on the page.
  claimedRefs: (envelope) => (envelope.expect_after ? [envelope.ref, envelope.expect_after.via_ref] : [envelope.ref]),
  violation: (envelope, table) => {
    // R-d: `action` must be one the schema offers. A model handing back an
    // enum-adjacent string (`'tap'`, `'press'`) is never silently mapped onto
    // the nearest value — that would hide that it did not commit to one.
    if (!STEP_ACTIONS.has(envelope.action)) return `action「${envelope.action}」不在 UserAction 枚举内`;

    // A lone `click` on a control that exists to take a value. Clicking a text
    // field cannot move a page, so a step that does only that leaves nothing
    // to wake the next call. Live journeys died exactly there, each having
    // written 「在搜索框输入 …」 in the step's own `why` and then emitted the
    // click without the input that sentence described — the shape a repair
    // round can fix. Runs after R-a, so the ref is known to be on the table.
    const role = table.items.find((i) => i.ref === envelope.ref)?.role ?? '';
    if (envelope.action === 'click' && VALUE_ENTRY_ROLES.has(role)) {
      return (
        `ref「${envelope.ref}」是一个用来填内容的控件，只点它不会有任何反应：` +
        '要么把 action 写成 input（并在 value 里给出要填的文字）或 select，要么改指别的控件'
      );
    }

    // The two *disguise* flags on the step itself. `structuralRedFlags` was
    // written once and shared, but until now only `fetchDoc` (06) asked it;
    // pointing did not.
    //
    // What the gap let through: `sameHost` sees `https://аpple.com` (Cyrillic
    // а) as a cross-site hop and shows the confirmation card — and the card
    // prints 「到 аpple.com」, a hostname the user cannot tell from the real
    // one *on screen*. Same for `userinfo`, which reads as the official host
    // right up to the `@`. These are the two the card cannot defend against,
    // because defending would mean the user adjudicating two strings that look
    // identical.
    //
    // **Only those two**, not all four, and the e2e said why: `private_network`
    // refused every step in the fixture suite, which serves from `127.0.0.1`.
    // That is not a test artefact — a user guiding themselves through their own
    // app on `localhost:3000` is an ordinary case, and every link on it is
    // "private". V-4 belongs to `fetchDoc`, where the worry is *we* reach into
    // the user's network; here the user is already standing there. `scheme` is
    // out for a smaller reason: `mailto:` links are everywhere and pointing at
    // one is legitimate ("click this to mail support").
    //
    // Refused rather than confirmed, because neither is a judgement about *who*
    // owns the address — both are facts about its shape (P-1, "is this party
    // imitating that one", stays deferred).
    const href = table.items.find((i) => i.ref === envelope.ref)?.href;
    if (href) {
      let flag: RedFlag | null = null;
      try {
        flag = structuralRedFlags(new URL(href));
      } catch {
        // Unparseable: `sameHost` already declines to vouch for it and the
        // cross-site card will ask. Not this rule's business.
      }
      if (flag && DISGUISE_FLAGS.has(flag))
        return `ref「${envelope.ref}」指向的地址有问题——${RED_FLAG_WHY[flag]}。改指别的控件，或者用 ask 把这件事交回给用户`;
    }
    return null;
  },
  rationales: (envelope) => [envelope.why],
  consequence: (state, envelope) => {
    const shown = toGuideStep(envelope, state.table);

    // The backstop, not the main defence: a model told where the user has
    // already been should stop on its own (the history in its user message),
    // and this catches the times it does not.
    //
    // Matched on title *and* on what that control did. The search box that
    // carried the user to `/repo` is still in the nav bar of `/repo`;
    // proposing it there to search for something else is ordinary use.
    // Proposing a control that changed the page in place, from a page that
    // has not gone anywhere since, is the loop — five live GitHub rounds all
    // stalled on exactly that. The costs are not symmetric: a misfire tells
    // the user "looks like you're there" and they ask again, while a missed
    // cycle burns the run's whole step budget.
    //
    // Scanned across the whole history, because the loop that shows up is a
    // *cycle*: 搜索按钮 → 搜索输入框 → 搜索按钮 reads as two different titles in
    // a row and slips past any check on the previous step alone.
    const seen = state.history.find(
      (h) => h.action === 'taken' && h.title === shown.title && h.effect?.kind === 'changed_in_place',
    );
    if (seen) {
      // Terminal, exactly as the model's own `done` is. An ending of its own:
      // this asserts that the guide cannot go on, never that the goal was
      // reached.
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
      steps: [shown],
      cursor: 0,
      history: [...state.history, { title: shown.title, url: state.table.url }],
      // Kept on the thread, not on the `GuideStep`: the renderer has no use
      // for a prediction, the host does — it is what the next breakpoint
      // checks the arrived page against.
      expect: envelope.expect_after,
    };
    // P-2: if this step leaves the site, the destination gets said out loud
    // before the user commits to it. The address comes from the *table* — the
    // page vouching for its own link — never from the model, which outputs
    // refs and never URLs (S-07).
    const target = state.table.items.find((i) => i.ref === shown.ref)?.href;
    if (target && !sameHost(state.table.url, target)) {
      const to = hostOf(target);
      // The step stays loaded behind the card: answering `true` presents it
      // without another model call, answering `false` costs nothing at all.
      if (to) return { state: { ...next, pendingCrossSite: to }, effects: [{ kind: 'requestCrossSiteConfirm', from: hostOf(state.table.url) ?? state.table.url, to }] };
    }
    return { state: next, effects: [present(next)] };
  },
};
