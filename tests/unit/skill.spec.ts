import { describe, expect, it } from 'vitest';
import { contributionsFor, enabledPlugins, pluginKey } from '@/agent/context/plugins';
import type { FlagStore } from '@/agent/flags';
import { guideAgent } from '@/agent/agents/guide/agent';
import { step } from '@/agent/thread/machine';
import { skill } from '@/agent/skills';
import type { PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';
import { flagStore } from './fixtures/flag-store';
import { textOf } from './fixtures/neutral';

const table = (url: string): PromptTable => ({
  snapshotId: 's1', url, title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0,
  stats: { elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false, ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 } },
  items: [{ ref: 'e1' as Ref, role: 'button', name: '保存', path: [] }],
});

describe('Skill：站点技能只在有它的站点上出现，且不进系统提示词', () => {
  it('github 上给出它那一段，开头照旧是那句引子', () => {
    const text = skill.contextFor('https://github.com/n8n-io/n8n') ?? '';
    expect(text.startsWith('关于这个站点，你需要知道：\n')).toBe(true);
    expect(text).toContain('组织名/仓库名');
  });

  it('弹出式搜索框这条写清楚了「点开」和「输入」要在同一份计划里', () => {
    // 第三轮 21 轮全部为这一个交互多花一次调用，而只发 click 的两轮直接冻死。
    expect(skill.contextFor('https://github.com/') ?? '').toContain('同一份计划');
  });

  it('官方文档站这条给的是路，不是出口——照着它应该继续走，而不是停下', () => {
    const text = skill.contextFor('https://github.com/n8n-io/n8n') ?? '';
    expect(text).toContain('-docs');
    // 「到不了」这类措辞会让模型把它当成停下来的许可；这条要说的是怎么过去。
    expect(text).not.toContain('到不了');
    expect(text).not.toContain('无法');
  });

  it('没有它的站点什么也不给——别的站点不为 GitHub 的语法付钱', () => {
    expect(skill.contextFor('https://example.com/x')).toBeUndefined();
  });

  it('系统提示词里没有任何站点专有内容', () => {
    expect(guideAgent.instructions).not.toContain('仓库');
    expect(guideAgent.instructions).not.toContain('github');
  });

  it('Plugin 的那一段落在不可信包裹之外——我们自己的话不能被当成页面内容', () => {
    const t = table('https://github.com/n8n-io/n8n');
    const user = textOf(guideAgent.buildMessages({ goal: 'g', table: t, history: { done: [], route: [] }, contributions: ['SITE-NOTE'] })[1]);
    expect(user).toContain('SITE-NOTE');
    expect(user.indexOf('SITE-NOTE')).toBeLessThan(user.indexOf('<untrusted_page_content'));
  });

  it('归约器发出的模型调用不带任何 Plugin 的内容——收集在归约器之外', () => {
    const { effects } = step(null, { kind: 'start', goal: '看看 issue', table: table('https://github.com/n8n-io/n8n'), effectId: 'fx-1' });
    const call = effects.find((e) => e.kind === 'callModel');
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain('关于这个站点');
  });
});

describe('Plugin 开关', () => {
  it('没写就按默认——Skill 默认开；写了 false 就关；读失败也按默认', async () => {
    // 登记表里现在只剩 Skill 一个：Memory 删掉了（CONTEXT.md 的词条写了为什么）。
    expect((await enabledPlugins(flagStore({}))).map((p) => p.name)).toEqual(['skill']);
    expect((await enabledPlugins(flagStore({ [pluginKey('skill')]: false }))).map((p) => p.name)).toEqual([]);
    const broken: FlagStore = { get: async () => { throw new Error('storage unavailable'); } };
    expect((await enabledPlugins(broken)).map((p) => p.name)).toEqual(['skill']);
  });

  it('只有开着的 Plugin 贡献它那一段', async () => {
    const url = 'https://github.com/n8n-io/n8n';
    expect(contributionsFor(await enabledPlugins(flagStore({})), url)).toEqual([skill.contextFor(url)]);
    expect(contributionsFor(await enabledPlugins(flagStore({ [pluginKey('skill')]: false })), url)).toEqual([]);
  });
});
