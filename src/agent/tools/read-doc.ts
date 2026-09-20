import type { GuideIntentModule } from '@/agent/agents/guide/intent-module';
import { fn, str } from '@/agent/agents/guide/tool-schema';
import type { ToolCall, ToolResult } from '@/agent/context/turn';
import { shapeMismatch } from '@/agent/envelope/contract';
import type { EffectOutcome } from '@/agent/thread/effect';
import { structuralRedFlags, type RedFlag } from '@/core/security/link-safety';
import type { InflightEffect, ThreadState, Turn } from '@/agent/thread/thread';
import { continueTurn, worldAtOf, type StepOut } from '@/agent/thread/transitions';
import type { Ref } from '@/shared/types';

/**
 * read_doc — a `Tool`: before deciding the next step, the model asks to read a
 * document the page itself links to, and what it says comes back to it
 * (CONTEXT.md `Tool`).
 *
 * Decided here, fetched in the panel (§8.3): the host judges the link, the
 * panel fetches only an address already approved, and the text comes back
 * into the step's conversation (`Turn`). A link the host will not fetch, and
 * a fetch that fails, come back the same way — as what the model is told,
 * for the model to decide what to do next.
 */
export interface ReadDocEnvelope {
  intent: 'read_doc';
  via_ref: Ref;
  query: string;
}

/**
 * The most of a document the model is given. Every later round of the step
 * sends it again, and at roughly a token a character of Chinese this is about
 * three large element tables; the model is told when there was more.
 */
export const DOC_TEXT_MAX_CHARS = 8000;

export const readDoc: GuideIntentModule<ReadDocEnvelope> = {
  intent: 'read_doc',
  kind: 'tool',
  tool: () =>
    fn('read_doc', '读一份这一页上链接到的站内文档的正文。只在必须先读它才能决定下一步时用。', ['via_ref', 'query'], {
      via_ref: str('元素表里那个指向文档的链接的 ref。'),
      query: str('你需要从那份文档里读到什么。'),
    }),
  policy:
    '- **read_doc**：必须先读一份站内文档的正文才能确定下一步时用——比如一条规则、一个期限、一种收费方式，只写在这一页链接到的说明文档里。via_ref 是这一页上那条文档链接。读到的正文（或读不到的原因）会交回给你，最长 ' +
    DOC_TEXT_MAX_CHARS +
    ' 个字。',
  recognize: (args) => {
    if (typeof args.via_ref !== 'string') return null;
    if (typeof args.query !== 'string') return null;
    return { intent: 'read_doc', via_ref: args.via_ref as Ref, query: args.query };
  },
  explain: () => shapeMismatch('read_doc', 'via_ref + query'),
  claimedRefs: (envelope) => [envelope.via_ref],
  violation: () => null,
  rationales: (envelope) => [envelope.query],
  consequence: (state, envelope, { nextEffectId, nextRev, call }) => fetchDocGate(state, envelope, nextEffectId, nextRev, call),
};

/**
 * What a fetch that came back becomes for the model: the text, cut to
 * `DOC_TEXT_MAX_CHARS`, or why there is none. The host re-applies the cut
 * rather than trusting the panel to have made it (§8.3).
 */
export function docResultOf(outcome: EffectOutcome): ToolResult {
  if (!outcome.ok) return { kind: 'no_doc', reason: outcome.error };
  if (typeof outcome.value !== 'string') return { kind: 'no_doc', reason: '抓回来的不是文字' };
  const text = outcome.value.trim();
  if (!text) return { kind: 'no_doc', reason: '这份文档里没有读得出的文字' };
  return text.length > DOC_TEXT_MAX_CHARS
    ? { kind: 'doc', text: text.slice(0, DOC_TEXT_MAX_CHARS), truncated: true }
    : { kind: 'doc', text, truncated: false };
}

/**
 * Whether a page's own link may be fetched as documentation — decided here,
 * fetched elsewhere.
 *
 * This function performs no network access of any kind, and that is the whole
 * arrangement: 设计文档 §8.3 puts the judgement in the service worker and the
 * fetching in the panel, so what crosses that boundary is always an address
 * that has already been approved. A panel that could decide for itself would
 * be a second place to weaken the rules.
 *
 * Only source ① of §6.1 (a link the page itself offers) is in scope. The
 * model's prior URLs and site search are not: S-07 already answered "what is
 * in range" by making the model output refs and never URLs, so the address
 * always comes from a link that really exists on the page the user is looking
 * at, and the page vouches for it.
 */
export type GroundDecision = { ok: true; url: string } | { ok: false; reason: RedFlag | 'unresolvable' };

export function groundFromPageLink(_viaRef: Ref, resolvedHref: string | undefined, _currentUrl: string): GroundDecision {
  // The ref resolved to nothing, or to something that is not a link. The page
  // may have changed between the model naming it and the host reading it
  // (§5.3's general rule) — a lookup that finds nothing says so.
  if (!resolvedHref) return { ok: false, reason: 'unresolvable' };

  let url: URL;
  try {
    url = new URL(resolvedHref);
  } catch {
    // Never hand an unvalidated string onwards. Anything the browser itself
    // could not parse is not an address.
    return { ok: false, reason: 'unresolvable' };
  }

  const flag = structuralRedFlags(url);
  if (flag) return { ok: false, reason: flag };

  return { ok: true, url: url.toString() };
}

/**
 * Why a doc fetch was declined, said plainly — and naming the host it would
 * really have gone to, which is the one fact worth acting on. Every line
 * describes what we observed about the address; none claims anything about
 * who is behind it (§8.4's limits — we are not a security product).
 */
function groundRefusal(reason: 'userinfo' | 'scheme' | 'private_network' | 'homograph' | 'unresolvable', href?: string): string {
  let host = '';
  try {
    if (href) host = new URL(href).hostname;
  } catch {
    /* an address we cannot read is described without one */
  }
  const at = host ? `（${host}）` : '';
  switch (reason) {
    case 'userinfo':
      return `这条链接的地址里藏了登录信息，真正会去的站点${at}和它看起来的不是同一个。`;
    case 'scheme':
      return '这条链接不是普通的网页地址。';
    case 'private_network':
      return `这条链接指向的是你自己网络里的地址${at}，不会是一份文档。`;
    case 'homograph':
      return `这条链接的主机名${at}不是纯 ASCII，我读不准它到底是哪个站点。`;
    case 'unresolvable':
      return '页面上已经找不到这条链接了。';
  }
}

/**
 * The one judgement only a doc fetch needs: is this a link the host will
 * fetch. There is no count of its own — every fetch sits between two model
 * calls of the same step, and the step's budget already bounds those.
 *
 * A link the host will not fetch is not the user's problem to hear about: it
 * becomes the result of the model's call, and the step's conversation goes on.
 */
function fetchDocGate(state: ThreadState, envelope: ReadDocEnvelope, effectId: string, nextRev: number, call: ToolCall): StepOut {
  // Every model call opens a turn (`tryEmitCallModel`), so this is the one
  // the call belongs to; an empty turn is what it would be if it had none.
  const turn: Turn = state.turn ?? { table: state.table, rounds: [] };
  // Only a link the page itself offers, and only after the four structural red
  // flags. The address comes from the table — the page vouching for its own
  // link — never from the model, which outputs refs and never URLs (S-07).
  const linked = state.table.items.find((i) => i.ref === envelope.via_ref)?.href;
  const decision = groundFromPageLink(envelope.via_ref, linked, state.table.url);
  if (!decision.ok) {
    const round = { call, result: { kind: 'no_doc' as const, reason: groundRefusal(decision.reason, linked) } };
    return continueTurn({ ...state, turn: { ...turn, rounds: [...turn.rounds, round] } }, effectId, nextRev);
  }
  const inflight: InflightEffect = { effectId, kind: 'fetchDoc', at: worldAtOf(state.table, nextRev) };
  return {
    state: { ...state, inflight, turn: { ...turn, pending: { effectId, call } } },
    effects: [{ kind: 'fetchDoc', effectId, viaRef: envelope.via_ref, query: envelope.query, url: decision.url }],
  };
}
