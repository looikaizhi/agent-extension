import type { GuideRouteHop, Ref } from '@/shared/types';
import { toPromptText } from '@/core/extractor/project';
import type { PromptTable } from '@/core/extractor/types';

/**
 * The user message builder — this is where S-01's structural isolation lives (design
 * doc §8.1). The element table is this product's only untrusted input (see
 * CONTEXT.md's `Element table` entry): every control name on it is text an
 * attacker who controls the page could have written. `buildQuestionUserMessage` never
 * tries to detect whether that text *looks like* an instruction — §8.1 is
 * explicit that heuristic can't be made to work and would misfire on the
 * exact content (an article discussing prompt injection) that must reach
 * the model untouched. What it does instead is structural: wrap the
 * serialized table between a pair of tags carrying a nonce generated
 * *after* extraction, so no page author can predict it while writing the
 * page, and therefore cannot forge a closing tag that ends the wrapper
 * early.
 */

/**
 * Restated next to the goal, not only in the system prompt.
 *
 * The first real-model smoke run answered a Malay question in Chinese: the
 * system-prompt instruction sat ~600 tokens away from the point of
 * generation, with the whole Chinese element table in between, and the
 * table's language won. Moving the goal *after* the table and repeating the
 * requirement inline is what actually made it hold — see `USER_TEMPLATE`.
 */
const GOAL_LEAD_IN = '用户的提问如下。请用与这句提问相同的语言作答：';

const WRAP_TAG = 'untrusted_page_content';

/**
 * The nonce is generated *after* extraction, from the extension's own
 * `crypto.randomUUID()` — a page author writing hostile control names has no
 * way to see it before it exists, so no name on the page can ever forge a
 * closing tag that matches it. This is the whole mechanism S-01 relies on
 * (design doc §8.1): structural unpredictability, not content filtering.
 */
function nonceFor(serialized: string): string {
  let candidate = crypto.randomUUID();
  // The one edge case that needs explicit handling:
  // if the serialized table happens to already contain the candidate
  // string, a forged closing tag using that same string would no longer be
  // distinguishable from the real one — regenerate rather than assume the
  // odds are low enough to ignore.
  while (serialized.includes(candidate)) candidate = crypto.randomUUID();
  return candidate;
}

function wrap(serialized: string, nonce: string): string {
  return `<${WRAP_TAG} nonce="${nonce}">${serialized}</${WRAP_TAG} nonce="${nonce}">`;
}

/** The question agent's user message: the page, then the question. */
export function buildQuestionUserMessage(question: string, table: PromptTable): string {
  const serialized = toPromptText(table);
  const nonce = nonceFor(serialized);
  // Page content first, the user's own question last. Two reasons, both
  // learned from the first real-model run rather than reasoned about up
  // front: the model answers in the language of whatever it read most
  // recently, so the goal has to be the last thing it reads; and putting our
  // framing after the untrusted block means the final instruction in context
  // is ours, not text the page author controls.
  return `${wrap(serialized, nonce)}\n\n${GOAL_LEAD_IN}\n${question}`;
}

/**
 * `guide` mode's prompt builder. Deliberately a
 * near-duplicate of `buildQuestionUserMessage` rather than a parameterised merge of the
 * two: nonce generation, wrapping and the goal-last ordering are the one
 * mechanism both share, and are reused verbatim (`nonceFor`, `wrap`,
 * `GOAL_LEAD_IN`) rather than reinvented. Everything else (which shape guide, which
 * fields the model may invent) differs enough between the two call sites
 * that a shared "mode" parameter would just be an if-branch wearing a
 * function signature.
 *
 * Same ordering discipline as `buildQuestionUserMessage`, learned the same way (first
 * real-model run, see `GOAL_LEAD_IN`'s doc comment): the field-shape guide
 * for `route`/`steps`/`expect_after` is long, but it stays in the system
 * message, *before* the element table. `goal` remains the last thing in the
 * user message, after the table — moving it earlier "to sit closer to the
 * now-longer shape guide" is exactly the regression that comment warns
 * against.
 */
/**
 * Where the guide has already been. Assembled by the host from
 * `ThreadState.history`/`ThreadState.route`, never by this file.
 *
 * Both halves exist because a replan is a brand-new conversation — the model
 * is handed a goal and a table and nothing else. Five live rounds on
 * github.com all ended the same way: on the page the user had just been sent
 * to, the model proposed the very step that sent them there. It was not
 * failing; with no record of what it had said and no shape for "you have
 * arrived", pointing at the most goal-shaped control was the best of the
 * three moves it had.
 */
export interface GuideHistory {
  /** Steps already put on screen, oldest first. */
  done: readonly { title: string; url: string; outcome: string; landedAt?: string }[];
  /** The waypoints given last time, so the next set continues the journey
   *  rather than restarting it. Still replaced wholesale in `ThreadState`
   *  (05's rule, unchanged) — continuity comes from what the model *reads*,
   *  never from us concatenating what it writes. */
  route: readonly GuideRouteHop[];
}

const OUTCOME_TEXT: Record<string, string> = {
  confirmed: '照做了，页面确实变了',
  invalidated: '这一步的目标在页面上找不到了',
  unknown: '还没有确认',
  /** Written to be acted on, not merely recorded. The only reader of this line
   *  is a model being asked for a *replacement* step, so "点了没反应" alone
   *  would leave it free to propose the same control again — which is what a
   *  live journey does when the dead control is a text field it answered with
   *  a lone `click`. Naming the exit is the whole value of the sentence. */
  failed: '照做了，但页面没有任何变化——这个控件推不动，换一个入口',
};

/**
 * Stated as accomplished fact plus an exit, never as a prohibition. "不要再指
 * 同一个控件" would drag that control into context and make it *more*
 * available, not less; saying where the user has already been, and that `done`
 * exists, removes the reason to repeat instead.
 */
function historyText(history: GuideHistory): string {
  if (history.done.length === 0 && history.route.length === 0) return '';
  const parts: string[] = [];
  if (history.route.length > 0) {
    const waypoints = history.route.map((h) => `${h.at} → ${h.goal}`).join('；');
    // Two different situations reach this paragraph, and only one of them
    // moved. A replan after a dead control reads the *same* table on the
    // *same* page; telling it the user "已经照做并到了新的页面" would assert a
    // hop that never happened, and the route it then writes would start from a
    // page nobody is on. The waypoints themselves are still worth carrying
    // either way — dropping them is what makes the model re-plan the whole
    // journey from scratch every time.
    const stalled = history.done[history.done.length - 1]?.outcome === 'failed';
    parts.push(
      stalled
        ? `你上一次给出的粗路标是：${waypoints}——那是站在这一页上给出的，而它的第一步没能推动页面。请基于下面这张元素表，换一条路往前走。`
        : `你上一次给出的粗路标是：${waypoints}——那是站在**上一页**给出的。用户已经照做并到了新的页面，所以这条路标里已经走完的部分不用再走一遍；请基于下面这张新的元素表，重新给出从**现在这一页**往前的路标。`,
    );
  }
  if (history.done.length > 0) {
    const lines = history.done.map(
      (d, i) =>
        `${i + 1}. 在 ${d.url} 让用户操作了「${d.title}」——${OUTCOME_TEXT[d.outcome] ?? d.outcome}` +
        (d.landedAt ? `，之后到了 ${d.landedAt}` : ''),
    );
    parts.push(`你在这条引导里已经让用户做过这些（最早的在前）：\n${lines.join('\n')}`);
    parts.push('如果根据下面这张元素表判断目标已经达成，就输出 done。');
  }
  return parts.join('\n\n');
}

/**
 * The guide's user message: the page, where this guide has already been, and
 * the goal — in that order.
 *
 * Only the user half lives here now. The system half used to spell out four
 * envelope shapes with their field lists; the tool schema carries that, so
 * saying it again would be paying twice to describe one thing (measured at
 * +30% per call). What the schema cannot say — which tool to reach for, how
 * to pick a control, how to read the page header — is the guide agent's
 * system message, assembled in `guide/agent.ts`.
 */
export function buildGuideUserMessage(
  goal: string,
  table: PromptTable,
  history?: GuideHistory,
  /** Paragraphs the enabled Plugins add (`CallModelParams.contributions`). */
  contributions: readonly string[] = [],
  /** Refs that appeared since the last call, when the page did not navigate
   *  (`CallModelParams.freshRefs`). Rendered as a `+new` mark. */
  fresh?: readonly Ref[],
  /** Supplied by `context/nonce.ts` so consecutive calls on one snapshot share a
   *  cacheable prefix. Omitted here means "mint a fresh one", which is what
   *  every caller outside the run loop wants. */
  nonce = nonceFor(toPromptText(table, fresh && new Set(fresh))),
): string {
  // One serialisation, and the nonce is checked against *this* string: the
  // marks are part of what gets wrapped, so a nonce vetted against an unmarked
  // rendering would be vetting the wrong text.
  const serialized = toPromptText(table, fresh && new Set(fresh));
  // What the Plugins add is our own text — the Skill is human-authored — so it
  // goes *before* the untrusted block and never inside it — putting our own text under the
  // nonce would teach the model that content in there can be trusted, which is
  // the one thing S-01's wrapper exists to deny.
  //
  // In the user message rather than the system message on purpose: the system
  // message must stay byte-identical across every site for the endpoint's
  // prefix cache to hit (measured at 896–1664 cached tokens per call), and a
  // per-site paragraph up there would cost that on every single request.
  // History sits between the untrusted page block and the goal — after the
  // page so it is ours and not the page author's last word, before the goal so
  // `GOAL_LEAD_IN`'s ordering discipline survives (the model answers in the
  // language of whatever it read most recently).
  const past = history ? historyText(history) : '';
  return [...contributions, wrap(serialized, nonce), past, `${GOAL_LEAD_IN}\n${goal}`].filter(Boolean).join('\n\n');
}
