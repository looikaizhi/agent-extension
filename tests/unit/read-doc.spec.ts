import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import { buildToolResultText } from '@/agent/context/user-message';
import { step } from '@/agent/thread/machine';
import { applyGuideInput, claimGuideEffect, peekGuideEffect, sweepExpiredGuideEffect, type GuideEffectDeps } from '@/agent/thread/writer';
import type { EffectRequest } from '@/agent/thread/effect';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import { runFetchDocEffect } from '@/entrypoints/sidepanel/effects';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { flagStore } from './fixtures/flag-store';

/**
 * `read_doc` (CONTEXT.md `Tool`): the model asks to read a document the page
 * itself links to, and what the document says comes back to it.
 *
 * The host decides whether the link may be fetched; the panel fetches; the
 * text goes back to the model as the result of its call — wrapped like any
 * other text from outside, and cut to a length. A refusal or a failed fetch
 * goes back to the model too, which decides what to do next. Nothing says to
 * the user that the extension cannot read documents, because now it can.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const DOC_URL = 'https://docs.example.com/2fa/expiry';
const PAGE: PromptTable = {
  snapshotId: 's1', url: 'https://example.com/settings/security', title: 't', structureHash: 'h1', omitted: 0, degraded: false, ambiguity: 0, stats,
  items: [
    { ref: 'e1' as Ref, role: 'switch', name: '启用两步验证', path: ['两步验证'] },
    { ref: 'e2' as Ref, role: 'link', name: '帮助文档', path: ['页脚'], href: DOC_URL },
    { ref: 'e3' as Ref, role: 'link', name: '内网文档', path: ['页脚'], href: 'http://192.168.1.10/docs' },
  ],
};
const READ = { via_ref: 'e2', query: '验证码多久过期' };
const at = (s: ThreadState) => s.inflight!.at;
const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);

/** Started, and the model has just asked to read a document. */
function asking(args: unknown = READ) {
  const started = step(null, { kind: 'start', goal: '验证码多久过期', table: PAGE, effectId: 'fx-1' });
  return step(started.state, {
    kind: 'effect_result', effectId: 'fx-1', at: at(started.state),
    outcome: { ok: true, providerCalls: 1, tool: 'read_doc', value: JSON.stringify(args), callId: 'call_doc' },
    nextEffectId: 'fx-doc',
  });
}
const fetched = (s: ThreadState, outcome: { ok: true; value: unknown } | { ok: false; error: string }) =>
  step(s, {
    kind: 'effect_result', effectId: 'fx-doc', at: at(s),
    outcome: outcome.ok
      ? { ok: true, providerCalls: 0, value: outcome.value }
      : { ok: false, providerCalls: 0, error: outcome.error, retryable: true, failureKind: 'transport' },
    nextEffectId: 'fx-2',
  });

describe('read_doc 取代 need_docs', () => {
  it('模型看得到的是 read_doc', () => {
    const names = guideAgent.outputSchema({ goal: 'g', table: PAGE, history: { done: [], route: [] } }).map((t) => t.name);
    expect(names).toContain('read_doc');
    expect(names).not.toContain('need_docs');
  });
});

describe('宿主判定能抓 → 交给侧栏去抓，正文回到模型', () => {
  it('页面自己的链接、没有红旗 → 派出一次抓取，等它回来；这时这一轮记着那次调用', () => {
    const { state, effects } = asking();
    expect(ofKind(effects, 'fetchDoc')).toEqual([{ kind: 'fetchDoc', effectId: 'fx-doc', viaRef: 'e2', query: '验证码多久过期', url: DOC_URL }]);
    expect(state.inflight).toMatchObject({ effectId: 'fx-doc', kind: 'fetchDoc' });
    expect(state.turn?.pending?.call).toEqual({ id: 'call_doc', name: 'read_doc', args: JSON.stringify(READ) });
  });

  it('正文回来了 → 记成这一轮的结果，带着整段对话再问模型；页面那张表不换', () => {
    const { state } = asking();
    const back = fetched(state, { ok: true, value: '验证码 5 分钟内有效。连续输错三次，账号锁定 30 分钟。' });
    expect(back.state.turn?.rounds.at(-1)?.result).toEqual({
      kind: 'doc',
      text: '验证码 5 分钟内有效。连续输错三次，账号锁定 30 分钟。',
      truncated: false,
    });
    expect(back.state.table).toBe(PAGE);
    const [call] = ofKind(back.effects, 'callModel');
    expect(call?.turn?.rounds).toHaveLength(1);
  });

  it('正文太长 → 截到 8000 个字，并记下截过', () => {
    const { state } = asking();
    const back = fetched(state, { ok: true, value: '字'.repeat(20_000) });
    const result = back.state.turn?.rounds.at(-1)?.result;
    expect(result).toMatchObject({ kind: 'doc', truncated: true });
    expect(result?.kind === 'doc' && result.text.length).toBe(8000);
  });

  it('抓取失败 → 理由送回模型，由它决定下一步', () => {
    const { state } = asking();
    const back = fetched(state, { ok: false, error: '文档抓取失败：HTTP 404' });
    expect(back.state.turn?.rounds.at(-1)?.result).toEqual({ kind: 'no_doc', reason: '文档抓取失败：HTTP 404' });
    expect(ofKind(back.effects, 'notify')).toEqual([]);
    expect(ofKind(back.effects, 'callModel')).toHaveLength(1);
  });

  it('抓的时候页面变了 → 这份正文不接上，按新页面重新问一次', () => {
    const { state } = asking();
    const moved: PromptTable = { ...PAGE, url: 'https://example.com/settings/profile', snapshotId: 's2', structureHash: 'h2' };
    const woke = step(state, { kind: 'reading', reading: { kind: 'loaded', url: moved.url }, table: moved, nextEffectId: 'fx-wake' });
    expect(ofKind(woke.effects, 'callModel')).toHaveLength(0); // the fetch is still out
    const back = fetched(woke.state, { ok: true, value: '验证码 5 分钟内有效。' });
    const [call] = ofKind(back.effects, 'callModel');
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty('turn');
    expect(back.state.table).toBe(moved);
  });
});

describe('「依据」一轴：读过站内文档之后指的一步，如实说依据站内文档（10e）', () => {
  const POINT = { previous_step: 'first_plan', route: [{ at: '安全设置', goal: '开两步验证' }], why: '文档说在这里开', ref: 'e1', action: 'toggle', value: null, expect_after: null };
  const answer = (s: ThreadState, tool: string, args: unknown, next = 'fx-3') =>
    step(s, { kind: 'effect_result', effectId: s.inflight!.effectId, at: at(s), outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args) }, nextEffectId: next });

  it('这一步的对话里读到了文档，再指一步 → 依据是 documented', () => {
    const back = fetched(asking().state, { ok: true, value: '在「两步验证」里打开开关。' });
    expect(answer(back.state, 'point', POINT).state.evidence).toBe('documented');
  });

  it('去读了但没读到 → 依据仍是 model', () => {
    const back = fetched(asking().state, { ok: false, error: '文档抓取失败：HTTP 404' });
    expect(answer(back.state, 'point', POINT).state.evidence).toBe('model');
  });

  it('读的时候页面变了，那段对话作废 → 依据是 model：模型最后是在没有文档的情况下回答的', () => {
    const { state } = asking();
    const woke = step(state, { kind: 'reading', reading: { kind: 'changed' }, table: PAGE, nextEffectId: 'fx-wake' });
    const back = fetched(woke.state, { ok: true, value: '在「两步验证」里打开开关。' });
    expect(answer(back.state, 'point', POINT).state.evidence).toBe('model');
  });

  it('依据说的是屏上这一步：下一步没再读文档 → 回到 model', () => {
    const documented = answer(fetched(asking().state, { ok: true, value: '在「两步验证」里打开开关。' }).state, 'point', POINT).state;
    const used = step(documented, { kind: 'reading', reading: { kind: 'used', how: 'clicked' }, table: PAGE, nextEffectId: 'fx-4' });
    const next = answer(used.state, 'point', { ...POINT, previous_step: 'worked', ref: 'e2', action: 'click' }, 'fx-5');
    expect(next.state.evidence).toBe('model');
  });
});

describe('宿主拒绝抓取 → 理由送回模型', () => {
  it('链接指向内网地址 → 不抓；「没有读到」连同理由成为这一轮的结果，模型接着决定', () => {
    const { state, effects } = asking({ via_ref: 'e3', query: '内网文档里写了什么' });
    expect(ofKind(effects, 'fetchDoc')).toEqual([]);
    expect(ofKind(effects, 'notify')).toEqual([]);
    const round = state.turn?.rounds.at(-1);
    expect(round?.call.name).toBe('read_doc');
    expect(round?.result).toMatchObject({ kind: 'no_doc' });
    expect(round?.result.kind === 'no_doc' && round.result.reason).toContain('192.168.1.10');
    expect(ofKind(effects, 'callModel')).toHaveLength(1);
  });
});

describe('交回模型的那句话', () => {
  it('正文包在不可信内容标签里；截过的要说截过', () => {
    const whole = buildToolResultText({ kind: 'doc', text: '验证码 5 分钟内有效。', truncated: false }, 'N');
    expect(whole).toContain('<untrusted_page_content nonce="N">验证码 5 分钟内有效。</untrusted_page_content nonce="N">');
    expect(whole).not.toContain('后面还有');
    expect(buildToolResultText({ kind: 'doc', text: '字', truncated: true }, 'N')).toContain('后面还有');
  });

  it('没读到 → 说没读到、为什么', () => {
    expect(buildToolResultText({ kind: 'no_doc', reason: '文档抓取失败：HTTP 404' })).toContain('没有读到那份文档：文档抓取失败：HTTP 404');
  });
});

/* ═══════════ 宿主的写入链：请求真的发出去 ═══════════ */

function harness() {
  const data = new Map<string, unknown>();
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (k) => void data.delete(k),
  };
  const sent: EffectRequest[] = [];
  let minted = 0;
  const now = { value: 1_000 };
  const deps: GuideEffectDeps = {
    store,
    records: { get: async () => ({}), set: async () => {}, bytesInUse: async () => 0, quota: 1_000 },
    flags: flagStore({}),
    recent: async () => [],
    send: (r) => sent.push(r),
    now: () => now.value,
    newEffectId: () => `gen-${++minted}`,
  };
  return { deps, sent, now };
}
const T = 'tab-1' as ThreadId;

describe('写入链把抓取请求真的发出去', () => {
  it('批准了的链接 → 发出一个 fetchDoc 请求，地址就是页面上那条链接；不再告诉用户「扩展还不能读」', async () => {
    const { deps, sent } = harness();
    const started = await applyGuideInput(deps, T, { kind: 'start', goal: 'g', table: PAGE, effectId: 'fx-1' });
    const out = await applyGuideInput(deps, T, {
      kind: 'effect_result', effectId: 'fx-1', at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'read_doc', value: JSON.stringify(READ) },
    });
    const req = sent.at(-1);
    expect(req).toMatchObject({ kind: 'fetchDoc', params: { url: DOC_URL, viaRef: 'e2', query: '验证码多久过期' } });
    expect(out.state?.inflight?.effectId).toBe(req?.effectId);
    expect(out.effects.filter((e) => e.kind === 'notify')).toEqual([]);
  });

  it('抓取过了期限 → 清扫把「没读到」交回模型，接着问，而不是焊死', async () => {
    const { deps, sent, now } = harness();
    const started = await applyGuideInput(deps, T, { kind: 'start', goal: 'g', table: PAGE, effectId: 'fx-1' });
    await applyGuideInput(deps, T, {
      kind: 'effect_result', effectId: 'fx-1', at: started.state!.inflight!.at,
      outcome: { ok: true, providerCalls: 1, tool: 'read_doc', value: JSON.stringify(READ) },
    });
    // A fetch some panel took and never answered: only a claimed call can be late (06c).
    const out = await peekGuideEffect(deps.store, T);
    await claimGuideEffect(deps, T, out!.effectId, 'doc-A', async () => true);
    now.value += 10 * 60_000;
    const swept = await sweepExpiredGuideEffect(deps, T);
    expect(swept?.state?.turn?.rounds.at(-1)?.result).toMatchObject({ kind: 'no_doc' });
    expect(sent.at(-1)?.kind).toBe('callModel');
  });
});

/* ═══════════ 侧栏那一半：抓回来，取出正文 ═══════════ */

const docReq = (): EffectRequest & { kind: 'fetchDoc' } => ({
  effectId: 'fx-doc',
  threadId: 'tab-1',
  kind: 'fetchDoc',
  params: { viaRef: 'e2' as Ref, query: 'q', url: DOC_URL },
  at: { threadRev: 1, snapshotId: 's1', structureHash: 'h1', url: PAGE.url },
  deadline: 99_999,
});
const serving = (body: string, init: ResponseInit & { redirected?: boolean } = {}) =>
  (async () => new Response(body, init)) as unknown as typeof fetch;

describe('侧栏抓取：只交回读得出的正文', () => {
  it('网页 → 取出正文再交回，不交原始 HTML', async () => {
    const r = await runFetchDocEffect(
      docReq(),
      new AbortController().signal,
      serving('<html><body><script>x()</script><main>验证码 5 分钟内有效。</main></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      (html) => (html.includes('<main>') ? '验证码 5 分钟内有效。' : 'wrong'),
    );
    expect(r.outcome).toMatchObject({ ok: true, value: '验证码 5 分钟内有效。' });
  });

  it('纯文本 → 原样交回', async () => {
    const r = await runFetchDocEffect(docReq(), new AbortController().signal, serving('# 两步验证\n五分钟', { headers: { 'content-type': 'text/markdown' } }));
    expect(r.outcome).toMatchObject({ ok: true, value: '# 两步验证\n五分钟' });
  });

  it('不是网页也不是文字（PDF、图片）→ 说清读不了，不把二进制交给模型', async () => {
    const r = await runFetchDocEffect(docReq(), new AbortController().signal, serving('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } }));
    expect(r.outcome.ok).toBe(false);
    if (!r.outcome.ok) expect(r.outcome.error).toContain('application/pdf');
  });

  it('链接会跳到别处 → 不跟着跳，说清楚为什么没读', async () => {
    // What `redirect: 'manual'` hands back for a redirect: an opaque response with no status and no location.
    const opaque = (async () => ({ type: 'opaqueredirect', ok: false, status: 0, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch;
    const r = await runFetchDocEffect(docReq(), new AbortController().signal, opaque);
    expect(r.outcome.ok).toBe(false);
    if (!r.outcome.ok) expect(r.outcome.error).toContain('跳');
  });
});
