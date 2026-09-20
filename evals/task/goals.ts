import type { Acceptable, LastStep } from './arrival';

/**
 * The goals a Task eval walks: one journey a person might ask for, started
 * where such a person plausibly is, and a programmatic check of where it
 * counts as arrived (`arrival.ts`).
 *
 * Drafted by whoever works on the eval, finalized by the product's owner: only
 * the owner's standard says where a journey has arrived. The owner's verdicts
 * from run 6, and the calls the owner made on the draft on 2026-09-13, are
 * pinned in `tests/unit/arrival.spec.ts`, so a criterion here that contradicts
 * one of them turns that test red. This list was finalized by the owner on
 * 2026-09-14.
 *
 * Where each site's goals start:
 * - github.com: the front page. The way to a repository is its search box, and
 *   search results open in the same tab.
 * - gitee.com: the hutool repository. Gitee's search results, and the links in
 *   a README, open in a new tab; the guide stays with the tab it started on, so
 *   a journey through them cannot be walked by the product or the harness.
 * - help.aliyun.com: each product's Chinese documentation home. The
 *   documentation front page lists products inside a panel that neither a
 *   click, its filter box, nor hovering opened when the goals were drafted.
 *   Only documentation in the user's language counts (see `DOCS` below).
 *
 * Every goal carries the path someone walked by hand when it was drafted — the
 * proof it can be done at all — and `arrival.spec.ts` checks that its end is
 * judged arrived. Its screenshot is under `evals/task/reference/`.
 */

/** CONTEXT.md: seeing it is the goal (`Sighting goal`), or a step has to take
 *  effect (`Acting goal`). */
export type GoalType = 'sighting' | 'acting';

export interface Goal {
  id: string;
  site: string;
  /** Where the journey starts. */
  url: string;
  goal: string;
  type: GoalType;
  accept: readonly Acceptable[];
  reference: {
    /** What was clicked or typed, in order, starting from `url`. */
    steps: readonly string[];
    endUrl: string;
    /** What was on screen at the end, as `judge` reads it. */
    last: LastStep;
    /** The end, under `evals/task/reference/`. */
    shot: string;
    walked: string;
  };
}

/** The rest of a URL after its path: nothing, a slash, a query or a fragment. */
const END = String.raw`/?([?#].*)?$`;
const done = { done: true } as const;
const DONE: LastStep = { kind: 'done' };
const WALKED = '2026-09-13';

const REPO = String.raw`^https://github\.com/n8n-io/n8n`;
const SEARCH_N8N = '搜索框输入「n8n-io/n8n」并回车';
const GITHUB: readonly Goal[] = [
  {
    id: 'gh-repo-address',
    site: 'github.com',
    url: 'https://github.com',
    goal: '带我找到 n8n 这个开源项目，我想把它的仓库地址拿到手',
    type: 'acting',
    // An acting goal: seeing the address is not having it. Arrived while the
    // copy button or the clone URL box is still pointed at, or when the model
    // said done right after the user walked a step that hands the address
    // over — Copy, the clone URL box, or the Code menu that shows it. Done
    // said on the bare front page does not count (owner, 2026-09-13).
    accept: [
      {
        url: new RegExp(REPO + END),
        lastSteps: [
          { role: 'button', name: /copy/i },
          { role: 'textbox', name: /clone/i },
          { done: true, after: /copy|clone|^code$/i },
        ],
      },
    ],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', 'Code'],
      endUrl: 'https://github.com/n8n-io/n8n',
      last: { kind: 'done', after: 'Code' },
      shot: 'gh-repo-address.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-issues',
    site: 'github.com',
    url: 'https://github.com',
    goal: '我想看看 n8n 这个项目最近有哪些人提了 issue',
    type: 'sighting',
    // Run 6: the issue list, ended on `done`, is there (P1-2, P2-2); the same
    // list with one particular issue highlighted is not (P3-2).
    accept: [{ url: new RegExp(REPO + '/issues' + END), lastSteps: [done] }],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', 'Issues 387'],
      endUrl: 'https://github.com/n8n-io/n8n/issues',
      last: DONE,
      shot: 'gh-issues.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-license',
    site: 'github.com',
    url: 'https://github.com',
    goal: '帮我找到 n8n 这个项目用的是什么开源许可证',
    type: 'sighting',
    // Run 6: the repository's front page counts — its sidebar shows the licence.
    accept: [
      { url: new RegExp(REPO + END), lastSteps: [done] },
      { url: new RegExp(REPO + String.raw`/blob/[^/]+/LICENSE[^/]*$`, 'i'), lastSteps: [done] },
    ],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n'],
      endUrl: 'https://github.com/n8n-io/n8n',
      last: DONE,
      shot: 'gh-license.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-releases',
    site: 'github.com',
    url: 'https://github.com',
    goal: '带我去看 n8n 这个项目历次发布的版本',
    type: 'sighting',
    // Run 6: the tag list counts as well as the releases page. The front page
    // does not — its sidebar shows only the latest release (owner, 2026-09-13).
    accept: [{ url: new RegExp(REPO + '/(releases|tags)' + END), lastSteps: [done] }],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', 'Releases'],
      endUrl: 'https://github.com/n8n-io/n8n/releases',
      last: DONE,
      shot: 'gh-releases.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-contributing',
    site: 'github.com',
    url: 'https://github.com',
    goal: '我想读 n8n 这个项目的贡献指南',
    type: 'sighting',
    // The guide itself — its file, or the repository page with its Contributing
    // tab open (`?tab=contributing…`, now `#contributing-ov-file`). The front
    // page only links to it, and does not count (owner, 2026-09-13).
    accept: [
      { url: new RegExp(REPO + String.raw`/blob/[^/]+/CONTRIBUTING\.md([?#].*)?$`, 'i'), lastSteps: [done] },
      { url: new RegExp(REPO + String.raw`/?(\?(.*&)?tab=contributing|#contributing)`, 'i'), lastSteps: [done] },
    ],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', 'CONTRIBUTING.md'],
      endUrl: 'https://github.com/n8n-io/n8n/blob/master/CONTRIBUTING.md',
      last: DONE,
      shot: 'gh-contributing.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-docs-site',
    site: 'github.com',
    url: 'https://github.com',
    goal: '带我去看 n8n 的官方文档站',
    type: 'sighting',
    // Run 6: stopping on the docs repository with its link to docs.n8n.io
    // highlighted counts, even while that step waits behind the cross-site card.
    // Done on that repository, with the address only in its README, does not
    // (owner, 2026-09-13).
    accept: [
      { url: /^https:\/\/docs\.n8n\.io(\/|$)/, lastSteps: [done] },
      {
        url: new RegExp(String.raw`^https://github\.com/n8n-io/n8n-docs` + END),
        lastSteps: [{ role: 'link', name: /docs\.n8n\.io/ }],
      },
    ],
    reference: {
      steps: ['搜索框输入「n8n-io/n8n-docs」并回车', 'n8n-io/n8n-docs', 'docs.n8n.io'],
      endUrl: 'https://docs.n8n.io/',
      last: DONE,
      shot: 'gh-docs-site.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-ci',
    site: 'github.com',
    url: 'https://github.com',
    goal: '我想知道 n8n 这个仓库的 CI 是怎么配置的',
    type: 'sighting',
    // A workflow file, or the workflows directory, which lists every CI
    // configuration the repository has (owner, 2026-09-13).
    accept: [
      { url: new RegExp(REPO + String.raw`/blob/[^/]+/\.github/workflows/[^/?#]+\.ya?ml([?#].*)?$`), lastSteps: [done] },
      { url: new RegExp(REPO + String.raw`/tree/[^/]+/\.github/workflows` + END), lastSteps: [done] },
    ],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', '.github', 'workflows'],
      endUrl: 'https://github.com/n8n-io/n8n/tree/master/.github/workflows',
      last: DONE,
      shot: 'gh-ci.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-pulls',
    site: 'github.com',
    url: 'https://github.com',
    goal: '我想看看 n8n 这个项目现在有哪些等着合并的 pull request',
    type: 'sighting',
    accept: [{ url: new RegExp(REPO + '/pulls' + END), lastSteps: [done] }],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', 'Pull requests 770'],
      endUrl: 'https://github.com/n8n-io/n8n/pulls',
      last: DONE,
      shot: 'gh-pulls.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-branches',
    site: 'github.com',
    url: 'https://github.com',
    goal: 'n8n 这个仓库都有哪些分支？',
    type: 'sighting',
    accept: [{ url: new RegExp(REPO + '/branches' + END), lastSteps: [done] }],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', '1636 Branches'],
      endUrl: 'https://github.com/n8n-io/n8n/branches',
      last: DONE,
      shot: 'gh-branches.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gh-commits',
    site: 'github.com',
    url: 'https://github.com',
    goal: '带我看看 n8n 最近都提交了哪些代码',
    type: 'sighting',
    // The commit list, on any branch.
    accept: [{ url: new RegExp(REPO + String.raw`/commits(/[^?#]*)?([?#].*)?$`), lastSteps: [done] }],
    reference: {
      steps: [SEARCH_N8N, 'n8n-io/n8n', '24,227 Commits'],
      endUrl: 'https://github.com/n8n-io/n8n/commits/master/',
      last: DONE,
      shot: 'gh-commits.jpg',
      walked: WALKED,
    },
  },
];

const HUTOOL = 'https://gitee.com/chinabugotech/hutool';
const GREPO = String.raw`^https://gitee\.com/chinabugotech/hutool`;
const GITEE: readonly Goal[] = [
  {
    id: 'gitee-repo-address',
    site: 'gitee.com',
    url: HUTOOL,
    goal: '我想把 hutool 这个仓库的克隆地址拿到手',
    type: 'acting',
    // The same rule as github's: a copy button still pointed at, or done said
    // right after the user opened Clone or Download (克隆/下载) or copied.
    // Gitee's interface comes in either language, so both names count.
    accept: [
      {
        url: new RegExp(GREPO + END),
        lastSteps: [{ role: 'button', name: /copy|复制/i }, { done: true, after: /clone|download|copy|克隆|下载|复制/i }],
      },
    ],
    reference: {
      steps: ['Clone or Download'],
      endUrl: HUTOOL,
      last: { kind: 'done', after: 'Clone or Download' },
      shot: 'gitee-repo-address.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gitee-closed-issues',
    site: 'gitee.com',
    url: HUTOOL,
    goal: 'hutool 以前被关掉的 issue 有哪些？',
    type: 'sighting',
    // The issue list filtered to closed ones — gitee writes it `state=…`, or
    // rewrites it to `q=is:…`. Runs see the Chinese interface, where `closed`
    // is labelled 已完成 and `rejected` 已关闭: a user taking 「被关掉」 at its
    // word picks 已关闭 and is not wrong, so both count (owner, 2026-09-14).
    accept: [
      {
        url: new RegExp(GREPO + String.raw`/issues/?\?(.*&)?(state=(closed|rejected)|q=is(%3A|:)(closed|rejected))([&#].*)?$`),
        lastSteps: [done],
      },
    ],
    reference: {
      steps: ['Issues 3', 'Closed 4164'],
      endUrl: `${HUTOOL}/issues?q=is%3Aclosed`,
      last: DONE,
      shot: 'gitee-closed-issues.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gitee-merged-pulls',
    site: 'gitee.com',
    url: HUTOOL,
    goal: 'hutool 已经合并过哪些 Pull Request？',
    type: 'sighting',
    accept: [{ url: new RegExp(GREPO + String.raw`/pulls/?\?(.*&)?status=merged([&#].*)?$`), lastSteps: [done] }],
    reference: {
      steps: ['Pull Requests 2', 'Merged 658'],
      endUrl: `${HUTOOL}/pulls?assignee_id=&author_id=&label_ids=&label_text=&milestone_id=&priority=&project_id=chinabugotech%2Fhutool&project_type=&scope=&search=&single_label_id=&single_label_text=&sort=closed_at+desc&status=merged&target_project=&tester_id=`,
      last: DONE,
      shot: 'gitee-merged-pulls.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gitee-other-branch',
    site: 'gitee.com',
    url: HUTOOL,
    goal: '我想看看 hutool v7-dev 分支上的代码',
    type: 'sighting',
    // Switched in place through the branch picker above the file list. The
    // branch names on the branches page open in a new tab, which a guide
    // cannot follow.
    accept: [{ url: new RegExp(GREPO + '/tree/v7-dev' + END), lastSteps: [done] }],
    reference: {
      steps: ['v5-master（分支下拉框）', 'v7-dev'],
      endUrl: `${HUTOOL}/tree/v7-dev`,
      last: DONE,
      shot: 'gitee-other-branch.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gitee-core-pom',
    site: 'gitee.com',
    url: HUTOOL,
    goal: 'hutool-core 这个模块的 pom.xml 里写了哪些依赖？',
    type: 'sighting',
    accept: [{ url: new RegExp(GREPO + String.raw`/blob/[^/]+/hutool-core/pom\.xml` + END), lastSteps: [done] }],
    reference: {
      steps: ['hutool-core', 'pom.xml'],
      endUrl: `${HUTOOL}/blob/v5-master/hutool-core/pom.xml`,
      last: DONE,
      shot: 'gitee-core-pom.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'gitee-org',
    site: 'gitee.com',
    url: HUTOOL,
    goal: 'hutool 背后的组织 chinabugotech 还有哪些项目？',
    type: 'sighting',
    // The organization's page, or its project list.
    accept: [
      { url: new RegExp(String.raw`^https://gitee\.com/chinabugotech` + END), lastSteps: [done] },
      { url: new RegExp(String.raw`^https://gitee\.com/organizations/chinabugotech/projects` + END), lastSteps: [done] },
    ],
    reference: { steps: ['chinabugotech'], endUrl: 'https://gitee.com/chinabugotech', last: DONE, shot: 'gitee-org.jpg', walked: WALKED },
  },
  {
    id: 'gitee-javadoc',
    site: 'gitee.com',
    url: HUTOOL,
    goal: '带我去看 hutool 的 API 文档',
    type: 'sighting',
    // The repository's JavaDoc tab. The documentation sites its README links
    // to open in a new tab through gitee's leaving page, which a guide cannot
    // follow — so this is the one that can be reached.
    accept: [{ url: new RegExp(GREPO + '/javadoc' + END), lastSteps: [done] }],
    reference: { steps: ['JavaDoc'], endUrl: `${HUTOOL}/javadoc`, last: DONE, shot: 'gitee-javadoc.jpg', walked: WALKED },
  },
];

/**
 * Documentation in the language the user asked in — or English, where the
 * site has none in it (owner, 2026-09-13). Every goal here is asked in
 * Chinese, which the site has, so only `/zh/` pages count — the same page in
 * English is the wrong end.
 *
 * A goal asked in Malay, reaching the English page through the language
 * switcher, was tried and dropped: the switcher is an icon button with no
 * accessible name in the element table, so the product cannot point at it.
 */
const DOCS = String.raw`^https://help\.aliyun\.com/zh`;
/** A page of one product's Chinese documentation. */
const doc = (path: string) => new RegExp(DOCS + path + END);
const ALIYUN: readonly Goal[] = [
  {
    id: 'aliyun-ecs-create',
    site: 'help.aliyun.com',
    url: 'https://help.aliyun.com/zh/ecs/',
    goal: '带我去看怎么创建一台 ECS 实例',
    type: 'sighting',
    // The page on ways to create one, or any of the ways it leads to.
    accept: [{ url: new RegExp(DOCS + String.raw`/ecs/user-guide/create-instances(/[^?#]*)?([?#].*)?$`), lastSteps: [done] }],
    reference: {
      steps: ['创建实例'],
      endUrl: 'https://help.aliyun.com/zh/ecs/user-guide/create-instances/?spm=a2c4g.11174283.help-menu-25365.d_0_1_1',
      last: DONE,
      shot: 'aliyun-ecs-create.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'aliyun-ecs-regions',
    site: 'help.aliyun.com',
    url: 'https://help.aliyun.com/zh/ecs/',
    goal: 'ECS 在哪些地域和可用区可以买？',
    type: 'sighting',
    accept: [{ url: doc('/ecs/user-guide/regions-and-zones'), lastSteps: [done] }],
    reference: {
      steps: ['地域和可用区'],
      endUrl: 'https://help.aliyun.com/zh/ecs/user-guide/regions-and-zones?spm=a2c4g.11174283.help-menu-25365.d_0_0_5',
      last: DONE,
      shot: 'aliyun-ecs-regions.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'aliyun-ecs-billing-switch',
    site: 'help.aliyun.com',
    url: 'https://help.aliyun.com/zh/ecs/',
    goal: '我的 ECS 是包年包月的，想改成按量付费，怎么操作？',
    type: 'sighting',
    accept: [
      { url: doc(String.raw`/ecs/change-the-billing-method-of-an-instance-from-subscription-to-pay-as-you-go(-1)?`), lastSteps: [done] },
    ],
    reference: {
      steps: ['产品计费', '包年包月转按量付费'],
      endUrl:
        'https://help.aliyun.com/zh/ecs/change-the-billing-method-of-an-instance-from-subscription-to-pay-as-you-go-1?spm=a2c4g.11186623.help-menu-25365.d_2_1_0',
      last: DONE,
      shot: 'aliyun-ecs-billing-switch.jpg',
      walked: WALKED,
    },
  },
  {
    id: 'aliyun-rds-billing',
    site: 'help.aliyun.com',
    url: 'https://help.aliyun.com/zh/rds/',
    goal: '云数据库 RDS 是怎么收费的？',
    type: 'sighting',
    accept: [{ url: doc('/rds/billable-items-billing-methods-and-pricing'), lastSteps: [done] }],
    reference: {
      steps: ['如何收费'],
      endUrl: 'https://help.aliyun.com/zh/rds/billable-items-billing-methods-and-pricing?spm=a2c4g.11174283.0.0',
      last: DONE,
      shot: 'aliyun-rds-billing.jpg',
      walked: WALKED,
    },
  },
];

/**
 * 21 goals: github 10, gitee 7, aliyun 4.
 *
 * Five went out on 2026-09-16, every one of them a goal the owner had to mark
 * 「不作数」 — a captcha, a page that would not load, something that was not the
 * product's doing — on most or all of its journeys across t09 and t11:
 * `aliyun-ecs-release`, `aliyun-rds-mysql-lifecycle` and `gitee-maven` on
 * every one, `aliyun-sls-query` on 4 of 5, `aliyun-oss-lifecycle-fees` on 3 of
 * 5. A goal that cannot be judged costs a real run and an owner's attention
 * and returns nothing.
 *
 * The frozen corpora keep their states on purpose: `evals/decision/batch-1.ndjson`
 * is what the baseline was measured on, and `evals/decision/on-target.ndjson`
 * is what the 2026-09-16 prompt change was measured on. Rebuilding either to
 * match this list would throw those numbers away.
 */
export const GOALS: readonly Goal[] = [...GITHUB, ...GITEE, ...ALIYUN];
