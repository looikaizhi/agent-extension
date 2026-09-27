import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agreement, judge, type HumanVerdict, type LastStep } from '../../evals/task/arrival';
import { GOALS } from '../../evals/task/goals';

describe('任务集：每个目标都有一条亲手走通的参考路径', () => {
  it('每个目标的参考路径，终点都判「到」', () => {
    for (const g of GOALS)
      expect(judge(g.reference.endUrl, g.reference.last, g.accept), g.id).toEqual({ arrived: true, missed: null });
  });

  it('每条参考路径的截图都在 evals/task/reference/ 里', () => {
    const missing = GOALS.filter((g) => !existsSync(join(process.cwd(), 'evals', 'task', 'reference', g.reference.shot)));
    expect(missing.map((g) => g.id)).toEqual([]);
  });

  it('三个站点：github.com 10 个、gitee.com 7 个、help.aliyun.com 4 个；id 不重复；起点都在自己的站点上', () => {
    const count = (site: string) => GOALS.filter((g) => g.site === site).length;
    // 2026-09-16：判过「不作数」的 5 个目标已删（见 goals.ts 的 GOALS 注释）。
    expect([count('github.com'), count('gitee.com'), count('help.aliyun.com')]).toEqual([10, 7, 4]);
    expect(new Set(GOALS.map((g) => g.id)).size).toBe(GOALS.length);
    for (const g of GOALS) expect(new URL(g.url).hostname, g.id).toBe(g.site);
  });

  it('Sighting 与 Acting 两类都有', () => {
    expect(new Set(GOALS.map((g) => g.type))).toEqual(new Set(['sighting', 'acting']));
  });
});

/**
 * The programmatic Arrival check, against the owner's own verdicts.
 *
 * The first group runs `judge` over the real goal list with journeys the owner
 * judged in run 6, so it pins two things at once: the function reads both
 * halves, and the criteria in `goals.ts` still say what the owner said. When
 * the list is finalized, a criterion that contradicts one of these verdicts
 * turns this red.
 */
const accept = (id: string) => GOALS.find((g) => g.id === id)!.accept;
const DONE: LastStep = { kind: 'done' };
const step = (role: string, name: string, extra: Partial<Extract<LastStep, { kind: 'step' }>> = {}): LastStep => ({
  kind: 'step',
  role,
  name,
  action: 'click',
  ...extra,
});

describe('判定：用你在第六轮的判定核对 goals.ts 的判据', () => {
  it('issue 列表、以 done 收尾：到了（P1-2、P2-2）', () => {
    expect(judge('https://github.com/n8n-io/n8n/issues', DONE, accept('gh-issues'))).toEqual({ arrived: true, missed: null });
  });

  it('同样停在 issue 列表，但最后一步指着某一条 issue：没到，差在最后一步（P3-2）', () => {
    const verdict = judge('https://github.com/n8n-io/n8n/issues', step('link', 'Qdrant N8N update question'), accept('gh-issues'));
    expect(verdict).toEqual({ arrived: false, missed: 'last_step' });
  });

  it('找许可证停在仓库首页、以 done 收尾：到了（右侧栏就写着许可证）', () => {
    expect(judge('https://github.com/n8n-io/n8n', DONE, accept('gh-license')).arrived).toBe(true);
  });

  it('看发布版本停在 /tags、以 done 收尾：到了', () => {
    expect(judge('https://github.com/n8n-io/n8n/tags', DONE, accept('gh-releases')).arrived).toBe(true);
  });

  it('停在 n8n-docs 仓库页，跨站确认卡后面正是指向 docs.n8n.io 的那一步：到了', () => {
    const behind = step('link', 'docs.n8n.io', { behindCrossSiteCard: true });
    expect(judge('https://github.com/n8n-io/n8n-docs', behind, accept('gh-docs-site')).arrived).toBe(true);
  });

  it('终点不对：顶栏的「All issues」把人带到了 /issues/assigned，以 done 收尾也没到，差在终点', () => {
    expect(judge('https://github.com/issues/assigned', DONE, accept('gh-issues'))).toEqual({ arrived: false, missed: 'url' });
  });
});

describe('判定：你在 2026-09-13 定下的四处', () => {
  const HOME = 'https://github.com/n8n-io/n8n';

  it('拿仓库地址（Acting）：点过复制、克隆地址框或 Code 之后说 done 才算；只走到仓库首页就说 done，不算', () => {
    for (const after of ['Copy URL to clipboard', 'Clone with HTTPS url', 'Code'])
      expect(judge(HOME, { kind: 'done', after }, accept('gh-repo-address')).arrived, after).toBe(true);
    expect(judge(HOME, { kind: 'done', after: 'n8n-io/n8n' }, accept('gh-repo-address'))).toEqual({ arrived: false, missed: 'last_step' });
    expect(judge(HOME, DONE, accept('gh-repo-address'))).toEqual({ arrived: false, missed: 'last_step' });
  });

  it('历次发布、贡献指南：停在仓库首页以 done 收尾，都不算（终点不对）', () => {
    expect(judge(HOME, DONE, accept('gh-releases')).missed).toBe('url');
    expect(judge(HOME, DONE, accept('gh-contributing')).missed).toBe('url');
  });

  it('官方文档站：停在 n8n-docs 仓库页以 done 收尾，不算', () => {
    expect(judge('https://github.com/n8n-io/n8n-docs', DONE, accept('gh-docs-site'))).toEqual({ arrived: false, missed: 'last_step' });
  });

  it('文档用用户的语言：中文提问，停在同一篇文档的英文版上不算（终点不对）', () => {
    const zh = 'https://help.aliyun.com/zh/ecs/change-the-billing-method-of-an-instance-from-subscription-to-pay-as-you-go-1?spm=a2c4g.1';
    expect(judge(zh, DONE, accept('aliyun-ecs-billing-switch')).arrived).toBe(true);
    expect(judge(zh.replace('/zh/', '/en/'), DONE, accept('aliyun-ecs-billing-switch')).missed).toBe('url');
  });

  it('CI 配置：停在 .github/workflows 目录页以 done 收尾，算', () => {
    expect(judge('https://github.com/n8n-io/n8n/tree/master/.github/workflows', DONE, accept('gh-ci')).arrived).toBe(true);
  });
});

describe('判定：两半各自的规矩', () => {
  it('终点和最后一步是成对的：n8n-docs 仓库页上以 done 收尾不算，docs.n8n.io 上以 done 收尾算', () => {
    expect(judge('https://github.com/n8n-io/n8n-docs', DONE, accept('gh-docs-site'))).toEqual({ arrived: false, missed: 'last_step' });
    expect(judge('https://docs.n8n.io/', DONE, accept('gh-docs-site')).arrived).toBe(true);
  });

  it('屏幕上什么都没有（打转兜底、配额用完）永远不算到，哪怕终点是对的', () => {
    const none: LastStep = { kind: 'none', why: 'loop_backstop' };
    expect(judge('https://github.com/n8n-io/n8n/issues', none, accept('gh-issues'))).toEqual({ arrived: false, missed: 'last_step' });
  });

  it('控件要 role 和名字都对：同名但 role 不同不算', () => {
    expect(judge('https://github.com/n8n-io/n8n', step('button', 'Copy url to clipboard'), accept('gh-repo-address')).arrived).toBe(true);
    expect(judge('https://github.com/n8n-io/n8n', step('link', 'Copy url to clipboard'), accept('gh-repo-address')).arrived).toBe(false);
  });

  it('终点按整条 URL 比：别的仓库里同名的路径不算', () => {
    expect(judge('https://github.com/someone/n8n/issues', DONE, accept('gh-issues')).missed).toBe('url');
    expect(judge('https://github.com/n8n-io/n8n/issues/38088', DONE, accept('gh-issues')).missed).toBe('url');
  });

  it('同一个判据连判两次结果相同（没有带 g 的正则留下状态）', () => {
    for (const g of GOALS) for (const a of g.accept) expect(a.url.flags, `${g.id} ${a.url}`).not.toContain('g');
    const once = judge('https://github.com/n8n-io/n8n/releases', DONE, accept('gh-releases'));
    expect(judge('https://github.com/n8n-io/n8n/releases', DONE, accept('gh-releases'))).toEqual(once);
  });
});

describe('对账：程序化判定与你的判定', () => {
  const pair = (programmatic: boolean, human: HumanVerdict) => ({ programmatic, human });

  it('一致率、precision、recall 与手算一致；不作数的趟不计', () => {
    // Program says arrived on 4: owner agrees on 3 (tp), not on 1 (fp).
    // Program says not arrived on 4: owner says arrived on 1 (fn), not on 3 (tn).
    // Two more are 不作数 and count for neither.
    const pairs = [
      pair(true, 'arrived'),
      pair(true, 'arrived'),
      pair(true, 'arrived'),
      pair(true, 'wrong_last_step'),
      pair(false, 'arrived'),
      pair(false, 'wrong_end'),
      pair(false, 'wrong_end'),
      pair(false, 'wrong_last_step'),
      pair(true, 'void'),
      pair(false, 'void'),
    ];
    expect(agreement(pairs)).toEqual({
      judged: 8,
      void: 2,
      tp: 3,
      fp: 1,
      fn: 1,
      tn: 3,
      agreement: 6 / 8,
      precision: 3 / 4,
      recall: 3 / 4,
    });
  });

  it('分母为 0 时是 null（未测），不是 0%', () => {
    const none = agreement([]);
    expect([none.agreement, none.precision, none.recall]).toEqual([null, null, null]);
    // The program never said arrived: precision has nothing to be about.
    const neverArrived = agreement([pair(false, 'arrived'), pair(false, 'wrong_end')]);
    expect(neverArrived.precision).toBeNull();
    expect(neverArrived.recall).toBe(0);
    // Everything was 不作数.
    expect(agreement([pair(true, 'void')]).agreement).toBeNull();
  });
});
