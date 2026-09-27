import { describe, expect, it } from 'vitest';
import { guideAgent } from '@/agent/agents/guide/agent';
import type { Reading } from '@/agent/context/turn';
import { step } from '@/agent/thread/machine';
import type { MachineEffect, ThreadState } from '@/agent/thread/thread';
import { applyGuideInput, applyReading, applySaid, peekGuideThread, type GuideEffectDeps } from '@/agent/thread/writer';
import type { ThreadId, ThreadStore } from '@/agent/thread/ports';
import type { ExtractStats, PromptTable } from '@/core/extractor/types';
import type { GuideStep } from '@/shared/protocol';
import type { Ref } from '@/shared/types';
import { textOf } from './fixtures/neutral';

/**
 * CONTEXT.md `Reading`: the four observation sources — a whole page finished
 * loading, the user used the step we pointed at, its target went off the page,
 * the page's structure changed by itself — write down what they saw and
 * nothing else. The model reads it and decides.
 *
 * Three rules follow, and each has its own block below: a reading wakes the
 * model when nobody is asking it anything; a reading that arrives while the
 * model is being asked voids that conversation, and the model is asked again
 * with everything that happened; and what a step did is written down only when
 * the model answers next, from the page the step was pointed on and the page
 * the model last read.
 */

const stats: ExtractStats = {
  elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false,
  ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
};
const REPO = 'https://x.test/repo';
const ISSUES = 'https://x.test/repo/issues';
const page = (snapshotId: string, url: string, items: [string, string, string][]): PromptTable => ({
  snapshotId, url, title: 't', structureHash: `h-${items.map(([, , name]) => name).join(',')}`, omitted: 0, degraded: false, ambiguity: 0, stats,
  items: items.map(([ref, role, name]) => ({ ref: ref as Ref, role, name, path: ['主导航'] })),
});
const REPO_CONTROLS: [string, string, string][] = [['e1', 'link', 'Issues'], ['e2', 'link', 'Pull requests']];
/** The repo page, as the step was pointed on it. */
const A = page('s1', REPO, REPO_CONTROLS);
/** The same page read again a moment after the click: nothing on it changed. */
const A_AGAIN = page('s2', REPO, REPO_CONTROLS);
/** The same address, finishing its own load: more controls, and no step of ours made them. */
const A_GREW = page('s3', REPO, [...REPO_CONTROLS, ['e3', 'button', 'Star']]);
/** The page the link leads to. */
const B = page('s4', ISSUES, [['e1', 'link', 'New issue'], ['e2', 'link', 'Labels']]);
/** The new address already, and the old page's controls still on screen. */
const B_LAGGING = page('s5', ISSUES, REPO_CONTROLS);

const GOAL = '新建一个 issue';
const point = (ref: string) => ({
  previous_step: 'first_plan', route: [{ at: '仓库页', goal: '进入 Issues' }], why: '从这里进去',
  ref, action: 'click', value: null, expect_after: null,
});

const USED: Reading = { kind: 'used', how: 'clicked' };
const LOADED_B: Reading = { kind: 'loaded', url: ISSUES };
const LOST: Reading = { kind: 'target_lost' };
const CHANGED: Reading = { kind: 'changed' };
/** The renderer refused to paint the step: the page was no longer the one it was drawn from. */
const NOT_SHOWN: Reading = { kind: 'not_shown', why: 'elsewhere' };
/** The renderer refused to paint the step: it landed on a password-like field. */
const NOT_SHOWN_SENSITIVE: Reading = { kind: 'not_shown', why: 'sensitive' };
/** The renderer went to paint the step and its target was not on the page. */
const NOT_FOUND: Reading = { kind: 'not_found' };
/** The step's target is on the page, but disabled. */
const NOT_ACTIONABLE: Reading = { kind: 'not_actionable', why: 'disabled' };
/** The user said something more while the guide was going (08b). */
const SAID: Reading = { kind: 'said', text: '那个 Star 按钮是干什么的？' };

const ofKind = <K extends MachineEffect['kind']>(effects: MachineEffect[], kind: K) =>
  effects.filter((e): e is Extract<MachineEffect, { kind: K }> => e.kind === kind);
const answer = (s: ThreadState, tool: string, args: unknown, nextEffectId = 'fx-next') =>
  step(s, {
    kind: 'effect_result', effectId: s.inflight!.effectId, at: s.inflight!.at,
    outcome: { ok: true, providerCalls: 1, tool, value: JSON.stringify(args) },
    nextEffectId,
  });
const read = (s: ThreadState, reading: Reading, table: PromptTable | null, nextEffectId = 'fx-wake') =>
  step(s, { kind: 'reading', reading, table, nextEffectId });

/** The model has pointed at 「Issues」 on the repo page; nobody is being asked anything. */
function pointedAtIssues(): ThreadState {
  const started = step(null, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
  const pointed = answer(started.state, 'point', point('e1'));
  expect(pointed.state.inflight).toBeNull();
  return pointed.state;
}

describe('四个观察源只写读数', () => {
  it('用户用了指着的那一步 → 只记「做了」，不记做成了什么；带着读数唤醒模型', () => {
    const { state, effects } = read(pointedAtIssues(), USED, A_AGAIN);
    expect(state.history).toEqual([{ title: 'Issues', url: REPO, action: 'taken' }]);
    expect(effects.map((e) => e.kind)).toEqual(['callModel']);
    const [call] = ofKind(effects, 'callModel');
    expect(call?.table).toBe(A_AGAIN);
    expect(call?.since).toEqual({ readings: [USED], page: 'unchanged' });
  });

  it.each([
    ['整页加载完成', LOADED_B, B],
    ['目标消失', LOST, A_GREW],
    ['页面结构自己变了', CHANGED, A_GREW],
    ['要画的时候页面已经换了，没画出来', NOT_SHOWN, B],
    ['要画的那一步落在敏感输入框上，没画出来', NOT_SHOWN_SENSITIVE, A_AGAIN],
    // Not `unavailable`, and nothing said to the user: whether the target is
    // gone for good, or the step was wrong, is the model's to judge.
    ['要画的时候目标不在页面上', NOT_FOUND, A_AGAIN],
    // The step stays painted; whether to wait, or point elsewhere, is the model's.
    ['目标在页面上但此刻点不了', NOT_ACTIONABLE, A_AGAIN],
    // Not a new run: the guide going on hears it, and decides — a question on
    // the way, or a change of what to do.
    ['用户又说了一句', SAID, A_AGAIN],
  ] as const)('%s → 历史一个字不动，只唤醒模型', (_name, reading, table) => {
    const before = pointedAtIssues();
    const { state, effects } = read(before, reading, table);
    expect(state.history).toEqual(before.history);
    expect(effects.map((e) => e.kind)).toEqual(['callModel']);
    expect(ofKind(effects, 'callModel')[0]?.since?.readings).toEqual([reading]);
  });

  it('读不到这一页 → 读数照样交给模型，并告诉它此刻读不到；表不换', () => {
    const { state, effects } = read(pointedAtIssues(), USED, null);
    expect(state.table).toBe(A);
    expect(ofKind(effects, 'callModel')[0]?.since).toEqual({ readings: [USED], page: 'unreadable' });
  });
});

describe('正在问模型时来的读数：那段对话作废，带着全部读数重问一次', () => {
  it('调用在途 → 不另起调用；回答回来时丢掉，重问一次', () => {
    const waking = read(pointedAtIssues(), USED, A_AGAIN);
    const during = read(waking.state, CHANGED, A_GREW, 'fx-unused');
    expect(during.effects).toEqual([]);

    const back = answer(during.state, 'point', point('e2'), 'fx-again');
    expect(ofKind(back.effects, 'present')).toEqual([]);
    const [again] = ofKind(back.effects, 'callModel');
    expect(again?.effectId).toBe('fx-again');
    expect(again?.table).toBe(A_GREW);
    // What woke the voided call is still news to the model: it never got to answer it.
    expect(again?.since?.readings).toEqual([USED, CHANGED]);
  });

  it('来了好几条 → 仍然只重问一次，读数按先后都在', () => {
    const started = step(null, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
    let s = started.state;
    for (const [r, t] of [[CHANGED, A_GREW], [LOST, A_GREW], [LOADED_B, B]] as const) {
      const out = read(s, r, t, 'fx-unused');
      expect(ofKind(out.effects, 'callModel')).toEqual([]);
      s = out.state;
    }
    const back = answer(s, 'point', point('e1'));
    const calls = ofKind(back.effects, 'callModel');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.since?.readings).toEqual([CHANGED, LOST, LOADED_B]);
    expect(calls[0]?.table).toBe(B);
  });

  it('工具在执行（observe）→ 读回来的结果不接进对话，重问', () => {
    const started = step(null, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
    const observing = answer(started.state, 'observe', { why: '再看一眼' }, 'fx-obs');
    const during = read(observing.state, LOADED_B, B, 'fx-unused');
    expect(during.effects).toEqual([]);

    const back = step(during.state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: A_GREW }, nextEffectId: 'fx-again' });
    const [again] = ofKind(back.effects, 'callModel');
    expect(again?.turn).toBeUndefined();
    expect(again?.since?.readings).toEqual([LOADED_B]);
    // The page the reading brought is newer than the one the tool read.
    expect(again?.table).toBe(B);
  });

  it('文档在抓（read_doc）→ 抓回来的正文不接进对话，重问', () => {
    const docPage = page('d1', REPO, [['e1', 'link', '帮助文档']]);
    docPage.items[0] = { ...docPage.items[0]!, href: 'https://x.test/docs/issues' };
    const started = step(null, { kind: 'start', goal: GOAL, table: docPage, effectId: 'fx-1' });
    const asking = answer(started.state, 'read_doc', { via_ref: 'e1', query: '怎么新建' }, 'fx-doc');
    expect(asking.state.inflight?.kind).toBe('fetchDoc');
    const during = read(asking.state, CHANGED, A_GREW, 'fx-unused');
    expect(during.effects).toEqual([]);

    const back = step(during.state, {
      kind: 'effect_result', effectId: 'fx-doc', at: during.state.inflight!.at,
      outcome: { ok: true, providerCalls: 0, value: '正文' }, nextEffectId: 'fx-again',
    });
    const [again] = ofKind(back.effects, 'callModel');
    expect(again?.turn).toBeUndefined();
    expect(again?.since?.readings).toEqual([CHANGED]);
  });

  it('调用失败回来，期间有读数 → 重问，不对用户报失败', () => {
    const waking = read(pointedAtIssues(), USED, A_AGAIN);
    const during = read(waking.state, LOADED_B, B, 'fx-unused');
    const back = step(during.state, {
      kind: 'effect_result', effectId: during.state.inflight!.effectId, at: during.state.inflight!.at,
      outcome: { ok: false, providerCalls: 1, error: '断了', retryable: true, failureKind: 'transport' },
      nextEffectId: 'fx-again',
    });
    expect(ofKind(back.effects, 'notify')).toEqual([]);
    expect(ofKind(back.effects, 'callModel')[0]?.since?.readings).toEqual([USED, LOADED_B]);
  });

  it('回答是 done、地址没变 → 照样收下：done 不指任何控件，原地变化收不回它说的话', () => {
    const started = step(null, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
    const during = read(started.state, CHANGED, A_GREW, 'fx-unused');
    const back = answer(during.state, 'done', { evidence: 'content_on_page', why: '已经在这里了' });
    expect(back.state.ending).toBe('model_done');
  });
});

describe('模型被问着的时候用户又说了一句：不等那次回答，马上带着这句话重问', () => {
  // 页面上的变化未必推翻在途的回答（done 在同一页上照样收下）；用户的新话一定
  // 推翻：那次回答是对一个已经不完整的目标说的。等它回来只是让用户白等。

  it('调用在途 → 取消它，马上重问；读数都在', () => {
    const waking = read(pointedAtIssues(), USED, A_AGAIN);
    const voided = waking.state.inflight!.effectId;
    const out = read(waking.state, SAID, A_AGAIN, 'fx-said');
    expect(out.effects.map((e) => e.kind)).toEqual(['cancel', 'callModel']);
    expect(ofKind(out.effects, 'cancel')).toEqual([{ kind: 'cancel', effectId: voided }]);
    const [again] = ofKind(out.effects, 'callModel');
    expect(again?.effectId).toBe('fx-said');
    expect(again?.since?.readings).toEqual([USED, SAID]);
    expect(out.state.inflight?.effectId).toBe('fx-said');
  });

  it('被取消的那次调用后来还是回来了 → 丢掉，什么都不做', () => {
    const waking = read(pointedAtIssues(), USED, A_AGAIN);
    const stale = waking.state.inflight!;
    const said = read(waking.state, SAID, A_AGAIN, 'fx-said');
    const late = step(said.state, {
      kind: 'effect_result', effectId: stale.effectId, at: stale.at,
      outcome: { ok: true, providerCalls: 1, tool: 'done', value: JSON.stringify({ evidence: 'content_on_page', why: '到了' }) },
      nextEffectId: 'fx-late',
    });
    expect(late.effects).toEqual([]);
    expect(late.state.ending).toBeUndefined();
    expect(late.state.inflight).toEqual(said.state.inflight);
  });

  it('工具在执行（observe）→ 马上重问；工具的结果后来回来也不接', () => {
    const started = step(null, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
    const observing = answer(started.state, 'observe', { why: '再看一眼' }, 'fx-obs');
    const out = read(observing.state, SAID, A_AGAIN, 'fx-said');
    // 宿主自己读页面，没有东西要叫停。
    expect(out.effects.map((e) => e.kind)).toEqual(['callModel']);
    expect(ofKind(out.effects, 'callModel')[0]?.turn).toBeUndefined();

    const late = step(out.state, { kind: 'tool_result', effectId: 'fx-obs', result: { kind: 'page', table: A_GREW }, nextEffectId: 'fx-late' });
    expect(late.effects).toEqual([]);
  });

  it('文档在抓（read_doc）→ 叫停抓取，马上重问', () => {
    const docPage = page('d1', REPO, [['e1', 'link', '帮助文档']]);
    docPage.items[0] = { ...docPage.items[0]!, href: 'https://x.test/docs/issues' };
    const started = step(null, { kind: 'start', goal: GOAL, table: docPage, effectId: 'fx-1' });
    const asking = answer(started.state, 'read_doc', { via_ref: 'e1', query: '怎么新建' }, 'fx-doc');
    const out = read(asking.state, SAID, A_AGAIN, 'fx-said');
    expect(ofKind(out.effects, 'cancel')).toEqual([{ kind: 'cancel', effectId: 'fx-doc' }]);
    expect(ofKind(out.effects, 'callModel')[0]?.since?.readings).toEqual([SAID]);
  });
});

describe('这一步做成了什么，在模型指下一步时记', () => {
  it('症状 1（旧页自己加载完）：点完之后原地变了、随后才离开 → 在旧页上的回答作废，最后记成「到了新页」', () => {
    const woken = read(pointedAtIssues(), USED, A_GREW, 'fx-w1');
    // Nothing about what the step did is written down yet: the page growing
    // under the click is not the click's doing.
    expect(woken.state.history[0]?.effect).toBeUndefined();
    expect(ofKind(woken.effects, 'callModel')[0]?.since?.page).toBe('changed_in_place');

    const left = read(woken.state, LOADED_B, B, 'fx-unused');
    // The answer computed on the page being left arrives after the user left it.
    const stale = answer(left.state, 'point', point('e3'), 'fx-w2');
    expect(ofKind(stale.effects, 'present')).toEqual([]);
    expect(ofKind(stale.effects, 'callModel')[0]?.since).toEqual({ readings: [USED, LOADED_B], page: 'moved' });

    const next = answer(stale.state, 'point', point('e1'));
    expect(next.state.history[0]).toEqual({ title: 'Issues', url: REPO, action: 'taken', effect: { kind: 'moved', to: ISSUES } });
    expect(next.state.history[1]).toEqual({ title: 'New issue', url: ISSUES });
  });

  it('症状 1（地址先变、页面没跟上）：唤醒消息说得出「地址变了，控件没变」', () => {
    const woken = read(pointedAtIssues(), USED, B_LAGGING);
    const [call] = ofKind(woken.effects, 'callModel');
    expect(call?.since?.page).toBe('moved_same_controls');
    const text = textOf(guideAgent.buildMessages({ goal: GOAL, table: call!.table, history: call!.history, since: call!.since })[1]);
    expect(text).toContain('用户点了你指的那一步');
    expect(text).toContain(`地址变了，现在是 ${ISSUES}`);
    expect(text).toContain('页面上的控件和你上次回答时看到的完全一样');
  });

  it('重新读过、什么都没变 → none', () => {
    const woken = read(pointedAtIssues(), USED, A_AGAIN);
    const next = answer(woken.state, 'point', point('e2'));
    expect(next.state.history[0]?.effect).toEqual({ kind: 'none' });
  });

  it('每一次都读不到这一页 → unknown', () => {
    const woken = read(pointedAtIssues(), USED, null);
    const again = read(woken.state, LOADED_B, null, 'fx-unused');
    const redo = answer(again.state, 'observe', { why: '读不到' }, 'fx-w2');
    const next = answer(redo.state, 'point', point('e2'));
    expect(next.state.history[0]).toMatchObject({ action: 'taken', effect: { kind: 'unknown' } });
  });

  it('用户没用这一步，页面自己去了别处 → 不记「做了」，只记它之后到了哪里', () => {
    const woken = read(pointedAtIssues(), LOADED_B, B);
    const next = answer(woken.state, 'point', point('e1'));
    expect(next.state.history[0]).toEqual({ title: 'Issues', url: REPO, effect: { kind: 'moved', to: ISSUES } });
  });

  it('新出现的控件照旧标出来：比的是模型上次回答时那一页', () => {
    const woken = read(pointedAtIssues(), CHANGED, A_GREW);
    expect(ofKind(woken.effects, 'callModel')[0]?.freshRefs).toEqual(['e3']);
  });
});

describe('唤醒消息', () => {
  it('把读数按先后念出来，再说此刻这一页和上次回答时相比怎样', () => {
    const text = textOf(guideAgent.buildMessages({
      goal: GOAL, table: A_GREW, history: { done: [], route: [] },
      since: {
        readings: [USED, { kind: 'used', how: 'typed' }, LOST, CHANGED, LOADED_B, NOT_SHOWN, NOT_SHOWN_SENSITIVE, NOT_FOUND, NOT_ACTIONABLE, SAID],
        page: 'changed_in_place',
      },
    })[1]);
    const order = [
      '用户点了你指的那一步',
      '用户在你指的那一步里填了内容',
      '你指的那一步的目标从页面上消失了',
      '页面自己变了',
      `标签页加载完了一整页：${ISSUES}`,
      '你指的那一步没有画出来：要画的时候，这个标签页已经不在你回答时的那一页了',
      '你指的那一步没有画出来：它落在了密码、验证码这类敏感输入框上',
      '你指的那一步，扩展要画的时候在页面上没找到它的目标',
      '你指的那一步的目标在页面上，但此刻点不了：它是禁用的',
      '用户又说：「那个 Star 按钮是干什么的？」',
    ];
    const at = order.map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(text).toContain('地址没变，页面上的控件变了');
    // Ours, after the untrusted page and before the goal.
    expect(text.indexOf('用户点了你指的那一步')).toBeGreaterThan(text.indexOf('</untrusted_page_content'));
    expect(text.indexOf('用户点了你指的那一步')).toBeLessThan(text.indexOf(GOAL));
  });

  it.each([
    ['moved', '到了新的一页', ['还在这一页']],
    ['changed_in_place', '现在还在这一页', ['到了新的', '已经照做']],
    ['unchanged', '现在还在这一页', ['到了新的', '已经照做']],
    ['moved_same_controls', '见下面', ['到了新的', '还在这一页', '已经照做']],
    ['unreadable', '见下面', ['到了新的', '还在这一页', '已经照做']],
  ] as const)('路标那一段按此刻这一页说，不替它下结论：%s', (page, says, never) => {
    // The step a wake-up comes after is not settled yet (that happens when this
    // answer lands), so the route paragraph cannot read it off history; the
    // page comparison is what it has.
    const history = { done: [{ title: 'Issues', url: REPO, action: 'taken' as const }], route: [{ at: '仓库页', goal: '进入 Issues' }] };
    const text = textOf(guideAgent.buildMessages({ goal: GOAL, table: A, history, since: { readings: [USED], page } })[1]);
    const route = text.slice(text.indexOf('你上一次给出的粗路标'), text.indexOf('你在这条引导里'));
    expect(route).toContain(says);
    for (const n of never) expect(route).not.toContain(n);
  });

  it('没有读数 → 一个字都不多：没有读数的调用和从前逐字节相同', () => {
    const ctx = { goal: GOAL, table: A, history: { done: [], route: [] } };
    const nonce = () => 'N';
    expect(guideAgent.buildMessages({ ...ctx, since: undefined }, nonce)).toEqual(guideAgent.buildMessages(ctx, nonce));
  });

  it('一步之后一直读不到 → 这一步念成「照做了，之后一直读不到」', () => {
    const text = textOf(guideAgent.buildMessages({
      goal: GOAL, table: A,
      history: { done: [{ title: 'Issues', url: REPO, action: 'taken', effect: { kind: 'unknown' } }], route: [] },
    })[1]);
    expect(text).toContain('「Issues」——照做了，但之后扩展一直读不到这一页');
  });
});


/* ═══════════ the host side: one read and one reduction per reading, in order ═══════════ */

function harness() {
  const data = new Map<string, unknown>();
  const store: ThreadStore = {
    get: async (k) => (data.has(k) ? { [k]: data.get(k) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, v)),
    remove: async (k) => void data.delete(k),
  };
  const sent: string[] = [];
  let minted = 0;
  const deps: GuideEffectDeps = {
    store,
    records: { get: async () => ({}), set: async () => {}, bytesInUse: async () => 0, quota: 1_000_000 },
    flags: { get: async () => ({}) },
    recent: async () => [],
    send: (req) => void sent.push(req.effectId),
    now: () => 0,
    newEffectId: () => `gen-${++minted}`,
  };
  return { deps, sent };
}
const T = 'tab-1' as ThreadId;

async function idleWithStepOnScreen(deps: GuideEffectDeps) {
  const started = await applyGuideInput(deps, T, { kind: 'start', goal: GOAL, table: A, effectId: 'fx-1' });
  await applyGuideInput(deps, T, {
    kind: 'effect_result', effectId: 'fx-1', at: started.state!.inflight!.at,
    outcome: { ok: true, providerCalls: 1, tool: 'point', value: JSON.stringify(point('e1')) },
  });
  expect((await peekGuideThread(deps.store, T))?.inflight).toBeNull();
}

describe('宿主：每条读数读一次页面、落一次地，按到达的先后', () => {
  it('一起到的几条读数 → 只派出一次模型调用，其余的记着等它回来', async () => {
    const { deps, sent } = harness();
    await idleWithStepOnScreen(deps);
    const before = sent.length;
    await Promise.all([
      applyReading(deps, T, USED, async () => A_AGAIN, 'tab-1#1'),
      applyReading(deps, T, LOST, async () => A_GREW),
      applyReading(deps, T, LOADED_B, async () => B),
    ]);
    expect(sent.length - before).toBe(1);
    expect((await peekGuideThread(deps.store, T))?.readings).toEqual([LOST, LOADED_B]);
  });

  it('后到的读数先抽完，也不会被先到的那条盖掉：读页面和落地是一个串行单元', async () => {
    const { deps } = harness();
    await idleWithStepOnScreen(deps);
    let release!: () => void;
    const slow = new Promise<PromptTable>((r) => (release = () => r(A_GREW)));
    const first = applyReading(deps, T, CHANGED, () => slow);
    const second = applyReading(deps, T, LOADED_B, async () => B);
    // Long enough for the second reading to land, if nothing held it back.
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);
    expect((await peekGuideThread(deps.store, T))?.table).toBe(B);
  });

  it.each([
    ['目标不在页面上', NOT_FOUND],
    ['目标此刻点不了', NOT_ACTIONABLE],
    ['没画出来', NOT_SHOWN],
  ] as const)('「%s」说的是屏上那一步：对不上屏上那次呈现就丢掉，页面也不读', async (_name, reading) => {
    const { deps, sent } = harness();
    await idleWithStepOnScreen(deps);
    let reads = 0;
    expect(await applyReading(deps, T, reading, async () => (reads++, A_AGAIN), 'tab-1#0')).toBeNull();
    expect(reads).toBe(0);
    const matched = await applyReading(deps, T, reading, async () => (reads++, A_AGAIN), 'tab-1#1');
    expect(matched?.state?.readings ?? matched?.state?.turn?.since?.readings).toEqual([reading]);
    expect(sent).toHaveLength(2);
  });

  it('点击报告对不上屏上那次呈现 → 丢掉，页面也不读', async () => {
    const { deps, sent } = harness();
    await idleWithStepOnScreen(deps);
    let reads = 0;
    const out = await applyReading(deps, T, USED, async () => (reads++, A_AGAIN), 'tab-1#7');
    expect(out).toBeNull();
    expect(reads).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('这个标签页没有引导 → 什么都不做，页面也不读', async () => {
    const { deps } = harness();
    let reads = 0;
    expect(await applyReading(deps, T, LOADED_B, async () => (reads++, B))).toBeNull();
    expect(reads).toBe(0);
  });
});

describe('宿主：引导进行中用户又说了一句', () => {
  it('有一趟模型引导在走 → 这句话成为一条读数交给它，页面读一次', async () => {
    const { deps, sent } = harness();
    await idleWithStepOnScreen(deps);
    let reads = 0;
    const out = await applySaid(deps, T, SAID.text, async () => (reads++, A_AGAIN));
    expect(out).not.toBeNull();
    expect(reads).toBe(1);
    expect(sent).toHaveLength(2);
    expect((await peekGuideThread(deps.store, T))?.turn?.since?.readings).toEqual([SAID]);
  });

  it('没有引导在走 → 不接，交回去由宿主开新的一趟；页面也不读', async () => {
    const { deps } = harness();
    let reads = 0;
    expect(await applySaid(deps, T, SAID.text, async () => (reads++, A_AGAIN))).toBeNull();
    expect(reads).toBe(0);
  });

});
