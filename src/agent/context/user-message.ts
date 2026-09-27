import type { GuideHistoryEntry } from '@/agent/thread/thread';
import type { Reading, Since, ToolResult } from '@/agent/context/turn';
import type { Talk } from '@/agent/conversation/entries';
import type { GuideRouteHop, Ref } from '@/shared/types';
import { toPromptText } from '@/core/extractor/project';
import type { PromptTable } from '@/core/extractor/types';

/**
 * The user message builder — this is where S-01's structural isolation lives (design
 * doc §8.1). The element table is this product's only untrusted input (see
 * CONTEXT.md's `Element table` entry): every control name on it is text an
 * attacker who controls the page could have written. `buildGuideUserMessage` never
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
  done: readonly GuideHistoryEntry[];
  /** The waypoints given last time, so the next set continues the journey
   *  rather than restarting it. Still replaced wholesale in `ThreadState`
   *  (05's rule, unchanged) — continuity comes from what the model *reads*,
   *  never from us concatenating what it writes. */
  route: readonly GuideRouteHop[];
}

/**
 * How one earlier step is told to the model. These sentences are part of the
 * frozen model input: rewording any of them changes what the model reads.
 */
const OUTCOME_TEXT = {
  changed: '照做了，页面确实变了',
  /** A safety rule stopped the run on the page this step led to (P-3). A
   *  target that could not be found is not this: it is a reading the model
   *  hears when it happens, and nothing is written down. */
  unavailable: '引导在这一步之后为安全停下了',
  undecided: '还没有确认',
  /** Two different steps read this way, and the sentence has to be true of
   *  both. One did its job without touching this page — live run t11 recorded
   *  nine: copying a clone address, links that open in a new tab — and the old
   *  wording, 「这个控件推不动，换一个入口」, told the model all nine were dead
   *  controls. The other really did nothing, a step that was supposed to make
   *  something appear here; left at "nothing changed", the model proposes the
   *  same control again. So it says what was seen, names the kind of step that
   *  looks like this and worked, and gives the exit for the other kind — an
   *  exit, not a prohibition (`historyText` says why). */
  unchanged: '照做了，这一页没有变化——复制、在新标签页打开这类操作，做成了也是这样；如果这一步本该让这一页出现新东西，就换一个控件或换一种做法',
  /** Every read after the step failed, so what it did was never seen —
   *  said as exactly that, neither a success nor a dead control. */
  unread: '照做了，但之后扩展一直读不到这一页，不知道它起没起作用',
} as const;

const outcomeText = (d: GuideHistoryEntry): string => {
  if (d.action === 'unavailable') return OUTCOME_TEXT.unavailable;
  if (d.action !== 'taken' || d.effect === undefined) return OUTCOME_TEXT.undecided;
  if (d.effect.kind === 'unknown') return OUTCOME_TEXT.unread;
  return d.effect.kind === 'none' ? OUTCOME_TEXT.unchanged : OUTCOME_TEXT.changed;
};

/**
 * Stated as accomplished fact plus an exit, never as a prohibition. "不要再指
 * 同一个控件" would drag that control into context and make it *more*
 * available, not less; saying where the user has already been, and that `done`
 * exists, removes the reason to repeat instead.
 */
/** Where the route was given from, against where the user is now. */
function routeText(waypoints: string, history: GuideHistory, page: Since['page'] | undefined): string {
  const lead = `你上一次给出的粗路标是：${waypoints}`;
  // Woken by a reading, the page comparison is the fact: the step before this
  // call is not settled yet — that happens when this answer lands — so history
  // cannot say whether anything moved. A hop that never happened, asserted
  // here, has the model write a route from a page nobody is on.
  if (page === 'moved')
    return `${lead}——那是站在**上一页**给出的，现在已经到了新的一页，所以这条路标里已经走完的部分不用再走一遍；请基于下面这张新的元素表，重新给出从**现在这一页**往前的路标。`;
  if (page === 'changed_in_place' || page === 'unchanged')
    return `${lead}——那是站在这一页上给出的，现在还在这一页。请基于下面这张元素表判断接下来怎么走。`;
  if (page !== undefined) return `${lead}——那是你上次回答时给出的。这一页此刻怎样，见下面。`;
  // Not woken by a reading: the last step, settled, is what there is. Two
  // situations reach here, and only one of them moved. A step that left this
  // page as it was is not told it failed — a copy button leaves the page
  // exactly like this and did its job. The waypoints are worth carrying either
  // way: dropping them is what makes the model re-plan the whole journey.
  const last = history.done[history.done.length - 1];
  const stalled = last?.action === 'taken' && last.effect?.kind === 'none';
  return stalled
    ? `${lead}——那是站在这一页上给出的，而上一步之后这一页没有变化。请基于下面这张元素表判断接下来怎么走。`
    : `${lead}——那是站在**上一页**给出的。用户已经照做并到了新的页面，所以这条路标里已经走完的部分不用再走一遍；请基于下面这张新的元素表，重新给出从**现在这一页**往前的路标。`;
}

function historyText(history: GuideHistory, page?: Since['page']): string {
  if (history.done.length === 0 && history.route.length === 0) return '';
  const parts: string[] = [];
  if (history.route.length > 0) {
    parts.push(routeText(history.route.map((h) => `${h.at} → ${h.goal}`).join('；'), history, page));
  }
  if (history.done.length > 0) {
    const lines = history.done.map(
      (d, i) =>
        `${i + 1}. 在 ${d.url} 让用户操作了「${d.title}」——${outcomeText(d)}` +
        (d.effect?.kind === 'moved' ? `，之后到了 ${d.effect.to}` : ''),
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
/**
 * What was said earlier in this conversation, as the model is told it.
 *
 * Placed after the page and the history and immediately before the goal: it is
 * ours rather than the page author's, and the goal stays the last thing read
 * (`GOAL_LEAD_IN`'s ordering discipline).
 */
function talkText(recent: readonly Talk[]): string {
  const lines = recent.map((t) => `${t.who === 'user' ? '用户' : '你'}：${t.text}`);
  return `这条对话在这之前说过的话（最近的在最后）：\n${lines.join('\n')}`;
}

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
  /** What woke the model, when a reading did (`CallModelParams.since`). */
  since?: Since,
  /** What was said earlier in this conversation (`CallModelParams.recent`). */
  recent?: readonly Talk[],
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
  // What woke the model comes after the history: it is what happened since
  // the last step there, and it is ours, not the page's.
  const past = history ? historyText(history, since?.page) : '';
  const woke = since ? sinceText(since, table.url) : '';
  const talk = recent?.length ? talkText(recent) : '';
  return [...contributions, wrap(serialized, nonce), past, woke, talk, `${GOAL_LEAD_IN}\n${goal}`].filter(Boolean).join('\n\n');
}

/**
 * What each observation source saw, as the model is told it (CONTEXT.md
 * `Reading`). Facts only, and in the order they arrived: which of them
 * matters, and whether the page has finished answering, is the model's to
 * judge — with `wait_for` and `observe` if it wants another look.
 */
const READING_TEXT: { [K in Reading['kind']]: (r: Extract<Reading, { kind: K }>) => string } = {
  used: (r) => (r.how === 'typed' ? '用户在你指的那一步里填了内容，填完了。' : '用户点了你指的那一步。'),
  loaded: (r) => `这个标签页加载完了一整页：${r.url}`,
  target_lost: () => '你指的那一步的目标从页面上消失了。',
  changed: () => '页面自己变了：页面的结构有了变化。',
  not_shown: (r) =>
    r.why === 'sensitive'
      ? '你指的那一步没有画出来：它落在了密码、验证码这类敏感输入框上，扩展不会把它框出来。'
      : '你指的那一步没有画出来：要画的时候，这个标签页已经不在你回答时的那一页了。',
  not_found: () => '你指的那一步，扩展要画的时候在页面上没找到它的目标。页面之后再变，扩展会接着找，找到了就框出来。',
  not_actionable: (r) => `你指的那一步的目标在页面上，但此刻点不了：${NOT_ACTIONABLE_TEXT[r.why]}。`,
  said: (r) => `用户又说：「${r.text}」`,
};

const NOT_ACTIONABLE_TEXT: Record<Extract<Reading, { kind: 'not_actionable' }>['why'], string> = {
  disabled: '它是禁用的',
  covered: '它被别的内容挡住了',
  moving: '它还在动',
};

const readingText = (r: Reading): string => (READING_TEXT[r.kind] as (r: Reading) => string)(r);

/**
 * How the page shown now compares with the one the last answer was given on.
 * `moved_same_controls` is said in full because it is the one case the table
 * alone would mislead on: the address is new while every control is still the
 * old page's, and a plan made from those controls is a plan for the page
 * being left.
 */
function pageSinceText(page: Since['page'], url: string): string {
  switch (page) {
    case 'moved':
      return `地址变了，现在是 ${url}。`;
    case 'moved_same_controls':
      return `地址变了，现在是 ${url}；但页面上的控件和你上次回答时看到的完全一样。`;
    case 'changed_in_place':
      return '地址没变，页面上的控件变了；新出现的控件在上面的表里标了出来。';
    case 'unchanged':
      return '地址和页面上的控件都和你上次回答时看到的一样。';
    case 'unreadable':
      return '此刻读不到这一页：扩展没能从页面上读出元素表，页面可能正在跳转或刷新。上面那张表是你上次回答时的那一页。';
  }
}

function sinceText(since: Since, url: string): string {
  const lines = since.readings.map((r) => `- ${readingText(r)}`);
  return `你上次回答之后，扩展看到了这些（先发生的在前）：\n${lines.join('\n')}\n\n此刻这一页和你上次回答时相比：${pageSinceText(since.page, url)}`;
}

/**
 * The step's last call (ticket 09): only answers are on offer, and the model
 * is told so in so many words — a tool list with three names in it says what
 * is allowed, not why, and a model that meant to look again needs the why.
 * "Say what you have" is the rule this follows: running out of time to think
 * is a reason to answer with the best step there is, never to make one up;
 * with no step to point at, ask.
 */
export const FINAL_CALL_TEXT =
  '这一步你已经来回看过几次了，这一次请直接给结论，不能再看、再等、再读文档了：指出你现在认为最好的一步（point）；用户问的是这一页上的事，就直接回答（explain）；实在指不出来，就问用户（ask）；已经到了，就说 done。';

/**
 * What a tool round hands back to the model (`GuideContext.turn`).
 *
 * A page read again is the page's own text, exactly as untrusted as the table
 * in the user message (S-01), so it goes inside the same wrapper under its own
 * nonce. It is a new snapshot, and a ref means nothing outside the snapshot it
 * came from — which the text says, because the table in the first message is
 * still sitting there with refs of its own.
 *
 * A wait says how it went before the page: whether the text did what the
 * model expected, and after how long. A wait that ran out is said as exactly
 * that — the model asked, so the model hears it (CONTEXT.md `Reading`).
 */
export function buildToolResultText(result: ToolResult, nonce?: string): string {
  const page = (table: PromptTable | null) => {
    if (!table) return '此刻读不到这一页：扩展没能从页面上读出元素表，页面可能正在跳转或刷新。';
    const serialized = toPromptText(table);
    return `这是此刻重新读到的这一页。前面那张表里的 ref 已经作废，之后只用这张表里的：\n\n${wrap(serialized, nonce ?? nonceFor(serialized))}`;
  };
  switch (result.kind) {
    case 'page':
      return page(result.table);
    case 'unreadable':
      return page(null);
    case 'waited':
      return `${waitedText(result)}\n\n${page(result.table)}`;
    case 'doc':
      // A document is text from outside, exactly as untrusted as the page it
      // was linked from, so it goes inside the same wrapper.
      return `这是那份文档的正文${result.truncated ? '（只给出了开头一段，后面还有，没有给出）' : ''}：\n\n${wrap(result.text, nonce ?? nonceFor(result.text))}`;
    case 'no_doc':
      return `没有读到那份文档：${result.reason}`;
  }
}

/** Tenths, and no trailing `.0`: 「10 秒」, 「1.2 秒」. */
const secondsText = (s: number) => String(Math.round(s * 10) / 10);

function waitedText(w: Extract<ToolResult, { kind: 'waited' }>): string {
  if (w.met === null) return '没能等完：等的时候这一页离开了，或者刷新了。';
  const s = secondsText(w.seconds);
  if (!w.met) return `等了 ${s} 秒，没等到「${w.text}」${w.until === 'appears' ? '出现' : '消失'}。`;
  return w.until === 'appears' ? `等到了：${s} 秒后页面上出现了「${w.text}」。` : `等到了：${s} 秒后「${w.text}」从页面上消失了。`;
}
