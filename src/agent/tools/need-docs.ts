import type { GuideIntentModule } from '@/agent/agents/guide/intent-module';
import { fn, str } from '@/agent/agents/guide/tool-schema';
import { shapeMismatch } from '@/agent/envelope/contract';
import { structuralRedFlags, type RedFlag } from '@/core/security/link-safety';
import type { InflightEffect, ThreadState } from '@/agent/thread/thread';
import { dispatchBlocked, notify, worldAtOf, type StepOut } from '@/agent/thread/transitions';
import type { Ref } from '@/shared/types';

/**
 * need_docs — the guide agent's one `Tool`: before deciding the next step, the
 * model asks to read a document the page itself links to.
 *
 * Only the first half of that loop is built. The host approves the link and
 * the reducer asks for the fetch; putting the request on the wire to the panel,
 * and handing the document's text back to the model, are not built yet, so
 * today the user is told plainly that the extension cannot read it
 * (`thread/writer.ts`).
 */
export interface NeedDocsEnvelope {
  intent: 'need_docs';
  via_ref: Ref;
  query: string;
}

export const needDocs: GuideIntentModule<NeedDocsEnvelope> = {
  intent: 'need_docs',
  tool: () =>
    fn('need_docs', '只在必须先读一份站内文档的正文才能决定下一步时用。', ['via_ref', 'query'], {
      via_ref: str('元素表里那个指向文档的链接的 ref。'),
      query: str('你需要从那份文档里读到什么。'),
    }),
  policy: '- **need_docs**：需要先读一份站内文档的正文才能确定下一步。',
  recognize: (args) => {
    if (typeof args.via_ref !== 'string') return null;
    if (typeof args.query !== 'string') return null;
    return { intent: 'need_docs', via_ref: args.via_ref as Ref, query: args.query };
  },
  explain: () => shapeMismatch('need_docs', 'via_ref + query'),
  claimedRefs: (envelope) => [envelope.via_ref],
  violation: () => null,
  rationales: (envelope) => [envelope.query],
  consequence: (state, envelope, { nextEffectId, nextRev }) =>
    fetchDocGate(state, envelope.via_ref, envelope.query, nextEffectId, nextRev),
};

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

/** The doc-fetch counterpart of the reducer's model-call gate — the same two
 *  gates (the in-flight tombstone, then its own independent quota, against
 *  `docFetchCount`), plus the one judgement only a doc fetch needs. */
function fetchDocGate(state: ThreadState, viaRef: Ref, query: string, effectId: string, nextRev: number): StepOut {
  const blocked = dispatchBlocked(state, state.docFetchCount, 5, '这条引导已用满文档抓取上限（5 次），已停止。');
  if (blocked) return blocked;
  // 06: only a link the page itself offers, and only after the four
  // structural red flags. The address comes from the table — the page
  // vouching for its own link — never from the model, which outputs refs and
  // never URLs (S-07). Deciding here and fetching in the panel is §8.3's
  // split: what crosses that boundary is always already approved.
  const linked = state.table.items.find((i) => i.ref === viaRef)?.href;
  const decision = groundFromPageLink(viaRef, linked, state.table.url);
  if (!decision.ok) {
    return { state, effects: [notify(`没有抓取这份文档：${groundRefusal(decision.reason, linked)}`)] };
  }
  const inflight: InflightEffect = { effectId, kind: 'fetchDoc', at: worldAtOf(state.table, nextRev) };
  return {
    state: { ...state, docFetchCount: state.docFetchCount + 1, inflight },
    effects: [{ kind: 'fetchDoc', effectId, viaRef, query, url: decision.url }],
  };
}
