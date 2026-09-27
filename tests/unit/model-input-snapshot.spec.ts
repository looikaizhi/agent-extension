import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import type { GuideContext } from '@/agent/agents/guide/agent';
import { modelRequestFor, type ModelCallOptions } from '@/agent/provider/call';
import type { ModelDelta, ModelMessage, ModelRequest } from '@/agent/provider/types';
import { answering } from './fixtures/neutral';
import type { GuideHistory } from '@/agent/context/user-message';
import { PLUGINS, contributionsFor, enabledPlugins, pluginKey } from '@/agent/context/plugins';
import type { PromptTable } from '@/core/extractor/types';
import { DEFAULT_CONFIG, type ProviderConfig } from '@/shared/settings';
import { flagStore } from './fixtures/flag-store';
import { TABLES, goldenGuideCalls } from './fixtures/golden-guide-envelopes';

/**
 * What the two agents actually send to the model, frozen byte for byte.
 *
 * A change that alters what the model reads has to change these two files,
 * which puts it in front of a reviewer instead of hiding behind a green suite;
 * a restructuring that claims to change nothing must leave them untouched.
 * `toContain` checks on the system prompt cannot make that claim: they stay
 * green while every sentence around the checked phrase changes.
 *
 * The guide side runs the real run loop against a recording `complete`, so
 * what is captured is what goes out — every message with every field, the
 * request options with the tool schema, and the repair round included. There
 * is one agent, and a question is asked through it like anything else.
 *
 * Rendering folds repeats ("same as …") so the file stays readable, but every
 * fold is decided by comparing the whole serialized value, never a part.
 *
 * The nonce that wraps the element table is random by design (S-01). It is the
 * one byte range pinned here, to a fixed value, so the rest can be compared.
 * It is pinned through a nonce cache, the way the panel calls the run loop, and
 * through `randomUUID` for anything that mints its own.
 */

const NONCE = '00000000-0000-4000-8000-000000000000';

type ScriptedReply = { tool: string; args: string; id?: string };

/**
 * Stands in for `callModel`: answers each request with the next scripted tool
 * call and records the whole neutral request it would have sent.
 *
 * The *whole* request, not the half the agent wrote: `modelRequestFor` adds
 * what the endpoint needs — the model name, the temperature, a preset's own
 * fields — and those are as much "what the model is sent" as the messages are.
 */
function recordingComplete(replies: readonly ScriptedReply[]) {
  const sent: ModelRequest[] = [];
  let n = 0;
  async function* complete(
    cfg: ProviderConfig,
    messages: readonly ModelMessage[],
    _signal: AbortSignal,
    options?: ModelCallOptions,
  ): AsyncGenerator<ModelDelta> {
    sent.push(structuredClone(modelRequestFor(cfg, messages, options)) as ModelRequest);
    const r = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    yield* answering(r.tool, r.args, { ...(r.id ? { id: r.id } : {}) });
  }
  return { complete, sent };
}

/** Ends every run with one request, so a case only scripts what comes before. */
const DONE: ScriptedReply = {
  tool: 'done',
  id: 'call_done',
  args: JSON.stringify({ evidence: 'content_on_page', why: '要看的东西已经显示在这一页上' }),
};

async function sendGuide(ctx: GuideContext, repliesBeforeDone: readonly ScriptedReply[] = []): Promise<ModelRequest[]> {
  const { complete, sent } = recordingComplete([...repliesBeforeDone, DONE]);
  await runGuideToEnd(ctx, DEFAULT_CONFIG, new AbortController().signal, complete as never, undefined, () => NONCE);
  return sent;
}

const REPO = 'https://git.example.com/acme/widget';
const SETTINGS = `${REPO}/settings`;
const NO_HISTORY: GuideHistory = { done: [], route: [] };
const ROUTE: GuideHistory['route'] = [
  { at: '仓库设置页', goal: '找到可见性设置' },
  { at: '危险操作区', goal: '把仓库改成 private' },
];
const CONFIRMED = { title: 'Settings', url: REPO, action: 'taken', effect: { kind: 'moved', to: SETTINGS } } as const;

/** Every outcome once, ending on one still undecided. */
const HISTORY: GuideHistory = {
  done: [
    CONFIRMED,
    { title: 'Danger Zone', url: SETTINGS, action: 'taken', effect: { kind: 'none' } },
    { title: 'Change visibility', url: SETTINGS, action: 'unavailable' },
    { title: 'Make private', url: SETTINGS },
  ],
  route: ROUTE,
};

/** The last step left the page as it was — the one history that does not
 *  tell the model the user has reached a new page. */
const HISTORY_STALLED: GuideHistory = {
  done: [CONFIRMED, { title: 'Danger Zone', url: SETTINGS, action: 'taken', effect: { kind: 'none' } }],
  route: ROUTE,
};

/** A step has been pointed and done — what every wake-up comes after. */
const WOKEN_HISTORY: GuideHistory = { done: [{ title: 'Settings', url: REPO, action: 'taken' }], route: ROUTE };

const GITHUB_TABLE: PromptTable = { ...TABLES.route, snapshotId: 'snap-github', url: 'https://github.com/n8n-io/n8n' };
/** What the Plugins add on this page, collected the way the host collects it
 *  when a call is sent: every switch at its default, and every switch off. */
const pluginsOn = contributionsFor(await enabledPlugins(flagStore({})), GITHUB_TABLE.url);
const pluginsOff = contributionsFor(
  await enabledPlugins(flagStore(Object.fromEntries(PLUGINS.map((p) => [pluginKey(p.name), false])))),
  GITHUB_TABLE.url,
);

const consoleTable = TABLES['zh-console'];
const PRUNED: PromptTable = { ...consoleTable, snapshotId: 'snap-pruned', omitted: 37 };
const lastRefs = (t: PromptTable, count: number) => t.items.slice(-count).map((i) => i.ref);

/** Every distinct first-plan input in the golden corpus, then the constructed
 *  ones that reach the branches the corpus does not. */
const guideCases = (contributions: readonly string[]): { name: string; ctx: GuideContext; repliesBeforeDone?: ScriptedReply[] }[] => [
  ...[...new Map(goldenGuideCalls.map((c) => [`${c.tableId}|${c.goal}`, c])).values()].map((c) => ({
    name: `golden · ${c.tableId} · ${c.goal}`,
    ctx: { goal: c.goal, table: TABLES[c.tableId], history: NO_HISTORY },
  })),
  {
    name: '有历史：已确认（带落点）、照做了但这一页没变、目标消失、未定，外加上一次的路标',
    ctx: { goal: '把这个仓库从 public 改成 private', table: TABLES.route, history: HISTORY },
  },
  {
    name: '有历史：最后一步照做了但这一页没变，外加上一次的路标',
    ctx: { goal: '把这个仓库从 public 改成 private', table: TABLES.route, history: HISTORY_STALLED },
  },
  {
    name: '有历史：只有走过的步骤，没有路标',
    ctx: { goal: '把这个仓库从 public 改成 private', table: TABLES.route, history: { done: [CONFIRMED], route: [] } },
  },
  {
    name: '有历史：只有路标，还没有走过的步骤',
    ctx: { goal: '把这个仓库从 public 改成 private', table: TABLES.route, history: { done: [], route: ROUTE } },
  },
  {
    name: '有站点知识：github.com 上的一页',
    ctx: { goal: '带我去看这个仓库的 issue 列表', table: GITHUB_TABLE, history: NO_HISTORY, contributions },
  },
  {
    name: '站点知识、历史、新出现的 ref 同时出现：github.com 上的一页',
    ctx: {
      goal: '带我去看这个仓库的 issue 列表',
      table: GITHUB_TABLE,
      history: HISTORY,
      contributions,
      freshRefs: lastRefs(GITHUB_TABLE, 2),
    },
  },
  {
    name: '有新出现的 ref：页面没跳转，展开了一片',
    ctx: { goal: '把这条安全组规则删掉', table: consoleTable, history: NO_HISTORY, freshRefs: lastRefs(consoleTable, 2) },
  },
  {
    name: '元素表被裁剪',
    ctx: { goal: '把这台实例删掉', table: PRUNED, history: NO_HISTORY },
  },
  {
    name: '这一步里已经有过工具轮次：读不到、等了没等到、读到了页面、读了一份文档、一份没抓',
    ctx: {
      goal: '把这台实例删掉',
      // The page read last: the schema's refs come from it.
      table: PRUNED,
      history: NO_HISTORY,
      turn: {
        table: consoleTable,
        freshRefs: lastRefs(consoleTable, 1),
        rounds: [
          { call: { id: 'call_obs1', name: 'observe', args: JSON.stringify({ why: '正文像是还没加载出来' }) }, result: { kind: 'unreadable' } },
          {
            call: { id: 'call_wait', name: 'wait_for', args: JSON.stringify({ until: 'appears', text: '确认删除', seconds: 10 }) },
            result: { kind: 'waited', until: 'appears', text: '确认删除', seconds: 10, met: false, table: consoleTable },
          },
          { call: { id: 'call_obs2', name: 'observe', args: JSON.stringify({ why: '再看一眼' }) }, result: { kind: 'page', table: PRUNED } },
          {
            call: { id: 'call_doc1', name: 'read_doc', args: JSON.stringify({ via_ref: 'e9', query: '删除之后还能恢复吗' }) },
            result: { kind: 'doc', text: '实例删除后无法恢复，数据盘会一并释放。', truncated: true },
          },
          {
            call: { id: 'call_doc2', name: 'read_doc', args: JSON.stringify({ via_ref: 'e2', query: '收费规则' }) },
            result: { kind: 'no_doc', reason: '这条链接指向的是你自己网络里的地址（10.0.0.8），不会是一份文档。' },
          },
        ],
      },
    },
  },
  // Woken by readings (CONTEXT.md `Reading`): what the extension saw, in the
  // order it saw it, then how the page compares with the one the model last
  // answered on — each of the five comparisons once.
  {
    name: '读数唤醒：用户点了、目标消失、页面自己变了、整页加载完——换了地址',
    ctx: {
      goal: '把这个仓库从 public 改成 private',
      table: TABLES.route,
      history: WOKEN_HISTORY,
      since: {
        readings: [{ kind: 'used', how: 'clicked' }, { kind: 'target_lost' }, { kind: 'changed' }, { kind: 'loaded', url: SETTINGS }],
        page: 'moved',
      },
    },
  },
  {
    name: '读数唤醒：填完了——地址变了而控件一个没变',
    ctx: {
      goal: '把这个仓库从 public 改成 private',
      table: TABLES.route,
      history: WOKEN_HISTORY,
      since: { readings: [{ kind: 'used', how: 'typed' }], page: 'moved_same_controls' },
    },
  },
  {
    name: '读数唤醒：页面原地变了，新出现了控件',
    ctx: {
      goal: '把这条安全组规则删掉',
      table: consoleTable,
      history: WOKEN_HISTORY,
      freshRefs: lastRefs(consoleTable, 2),
      since: { readings: [{ kind: 'changed' }], page: 'changed_in_place' },
    },
  },
  {
    name: '读数唤醒：画面那一侧——没画出来（换了页、敏感框）、没找到、此刻点不了（禁用、挡住、在动）；页面没变',
    ctx: {
      goal: '把这条安全组规则删掉',
      table: consoleTable,
      history: WOKEN_HISTORY,
      since: {
        readings: [
          { kind: 'not_shown', why: 'elsewhere' },
          { kind: 'not_shown', why: 'sensitive' },
          { kind: 'not_found' },
          { kind: 'not_actionable', why: 'disabled' },
          { kind: 'not_actionable', why: 'covered' },
          { kind: 'not_actionable', why: 'moving' },
        ],
        page: 'unchanged',
      },
    },
  },
  {
    name: '读数唤醒：用户又说了一句——此刻读不到这一页',
    ctx: {
      goal: '把这条安全组规则删掉',
      table: consoleTable,
      history: WOKEN_HISTORY,
      since: { readings: [{ kind: 'said', text: '等等，先告诉我删掉之后还能不能恢复' }], page: 'unreadable' },
    },
  },
  {
    name: '一步的最后一次调用：只给回答，末尾说请直接给结论',
    ctx: {
      goal: '把这台实例删掉',
      table: consoleTable,
      history: NO_HISTORY,
      final: true,
      turn: {
        table: consoleTable,
        rounds: [{ call: { id: 'call_obs', name: 'observe', args: JSON.stringify({ why: '再看一眼' }) }, result: { kind: 'page', table: consoleTable } }],
      },
    },
  },
  {
    name: '修复轮：第一次的 arguments 不是合法 JSON，端点给了调用 id',
    ctx: { goal: '把这台实例删掉', table: consoleTable, history: NO_HISTORY },
    repliesBeforeDone: [{ tool: 'point', id: 'call_1', args: '{"route": [' }],
  },
  {
    name: '修复轮：第一次能解析但被校验拒绝（ref 不在表里），端点给了调用 id',
    ctx: { goal: '把这台实例删掉', table: consoleTable, history: NO_HISTORY },
    repliesBeforeDone: [
      {
        tool: 'point',
        id: 'call_2',
        args: JSON.stringify({
          previous_step: 'first_plan',
          route: [{ at: '实例页', goal: '删除实例' }],
          why: '删掉它',
          ref: 'e999',
          action: 'click',
          value: null,
          expect_after: null,
        }),
      },
    ],
  },
  {
    name: '修复轮：端点没给调用 id，只能原样重发',
    ctx: { goal: '把这台实例删掉', table: consoleTable, history: NO_HISTORY },
    repliesBeforeDone: [{ tool: 'point', args: '{"route": [' }],
  },
];

const RULE = '════════';
const SUB = '────';
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const header = (agent: string) => `# ${agent}发给模型的东西，逐字节快照。包裹元素表的随机标记固定为 ${NONCE}。`;

/** Every part a message carries, so a changed role, an empty text part, or a
 *  part that appeared from nowhere all show. Text is printed as text (it is
 *  what the model reads); anything else is printed as its own shape. */
function renderMessage(m: ModelMessage): string {
  const lines = [`${SUB} ${m.role}`];
  if (m.content.length === 0) lines.push('（没有任何内容分片）');
  for (const part of m.content) {
    if (part.type === 'text') lines.push(part.text === '' ? 'text: ""' : part.text);
    else lines.push(`${SUB}${SUB} ${part.type}\n${pretty(part)}`);
  }
  return lines.join('\n');
}

/** The system message is printed once per file; a message that matches it
 *  exactly is shown as a reference. */
const renderMessages = (messages: readonly ModelMessage[], system: ModelMessage) =>
  messages.map((m) => (same(m, system) ? `${SUB} system（与文件开头相同）` : renderMessage(m))).join('\n');

const systemBlock = (system: ModelMessage) =>
  `\n${RULE} system（下面凡写「与文件开头相同」的，逐字节等于这一条）\n${renderMessage(system)}`;

/** The request without the two big parts, which are printed on their own. */
const withoutTools = (r?: ModelRequest) => (r ? { ...r, messages: undefined, tools: undefined } : undefined);
const renderOptions = (r?: ModelRequest) => (r ? JSON.stringify(withoutTools(r)) : '无');

async function renderGuide(contributions: readonly string[]): Promise<string> {
  const cases = guideCases(contributions);
  const requests = await Promise.all(cases.map((c) => sendGuide(c.ctx, c.repliesBeforeDone)));
  const system = requests[0]![0]!.messages[0]!;
  const options = requests[0]![0]!;
  const out = [header('引导 agent '), systemBlock(system), `\n${RULE} 请求选项（工具 schema 另列）\n${renderOptions(options)}`];
  const toolsSeen = new Map<string, string>();

  for (const [i, c] of cases.entries()) {
    const [first, ...repairs] = requests[i]!;
    out.push(`\n${RULE} 用例：${c.name}`);
    out.push(renderMessages(first!.messages, system));
    out.push(
      same(withoutTools(first!), withoutTools(options))
        ? `${SUB} 请求选项：与文件开头相同`
        : `${SUB} 请求选项（与文件开头不同）\n${renderOptions(first!)}`,
    );
    const tools = pretty(first!.tools ?? null);
    const seenIn = toolsSeen.get(tools);
    out.push(seenIn ? `${SUB} tools：与「${seenIn}」相同` : `${SUB} tools\n${tools}`);
    if (!seenIn) toolsSeen.set(tools, c.name);

    // Every request after the first is the repair round this case exists to
    // show. Compared message by message against the first request, and the
    // options as a whole, so a repair that drifts in either shows.
    for (const [j, r] of repairs.entries()) {
      out.push(`${SUB}${SUB} 第 ${j + 2} 次请求`);
      out.push(
        r.messages
          .map((m, k) => (same(m, first!.messages[k]) ? `${SUB} 第 ${k + 1} 条：与第 1 次请求相同` : renderMessage(m)))
          .join('\n'),
      );
      out.push(
        same(withoutTools(r), withoutTools(first))
          ? `${SUB} 请求选项（含 tools）：与第 1 次请求相同`
          : `${SUB} 请求选项（含 tools，与第 1 次请求不同）\n${pretty({ ...r, messages: undefined })}`,
      );
    }
  }
  return out.join('\n') + '\n';
}

describe('发给模型的东西：逐字节快照', () => {
  beforeEach(() => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(NONCE as ReturnType<typeof crypto.randomUUID>);
  });
  afterEach(() => vi.restoreAllMocks());

  it('构造输入确实走到了各自的分支', () => {
    // Guards the fixture itself: a site with no notes, a table that was not
    // pruned, or a history whose last step did not fail would each silently
    // turn a constructed case into a duplicate of another.
    expect(pluginsOn).toHaveLength(1);
    expect(pluginsOff).toEqual([]);
    expect(PRUNED.omitted).toBeGreaterThan(0);
    expect(HISTORY_STALLED.done.at(-1)).toMatchObject({ action: 'taken', effect: { kind: 'none' } });
  });

  it('引导 agent：每条消息的全部字段、请求选项、工具 schema，以及修复轮', async () => {
    const text = await renderGuide(pluginsOn);
    expect(text).toContain(`nonce="${NONCE}"`);
    await expect(text).toMatchFileSnapshot('./snapshots/model-input.guide.txt');
  });

  it('引导 agent，Plugin 全关：只少站点技能那一段，其余逐字节一致', async () => {
    const on = await renderGuide(pluginsOn);
    const off = await renderGuide(pluginsOff);
    expect(on).toContain(pluginsOn[0]!);
    expect(on.split(`${pluginsOn[0]!}\n\n`).join('')).toBe(off);
    await expect(off).toMatchFileSnapshot('./snapshots/model-input.guide.plugins-off.txt');
  });
});
