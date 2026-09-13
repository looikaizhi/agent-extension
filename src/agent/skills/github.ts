import type { SiteSkill } from '.';

export const github: SiteSkill = {
  domains: ['github.com'],
  // Everything a general prompt cannot carry: this site's own vocabulary.
  // Every line is here because a live run paid for it.
  //
  // The first two: a journey typed 「n8n-io/n8n issues」 into the global
  // search, got a page of unrelated repositories back, and spent four more
  // hops flipping filters before giving up on a repo called `vitorfhc/videt`.
  //
  // The quick-search line: all 21 journeys of the third run opened that dialog
  // and then spent a *second* model call working out what to do inside it —
  // 21 calls, 14% of the whole run's budget, on one interaction. The journeys
  // that planned both steps at once are the ones that got through; the two
  // that emitted the click alone froze.
  //
  // The docs line: three journeys were asked for n8n's official documentation
  // site and none of them knew it lives on another domain. The one that got
  // there found `n8n-io/n8n-docs` first and read the link off its README —
  // that route is what this line records. It deliberately describes the *way*
  // rather than the destination: told only that the answer is off-site, a
  // model stops at the landing page instead of walking the two hops that
  // actually reach it.
  text: [
    '全局搜索按仓库名匹配，不接受"仓库名 + 你想在里面做什么"这样的词组。要打开某个仓库，输入它的 组织名/仓库名（例如 n8n-io/n8n）。',
    '仓库里的东西（issue、release、许可证、贡献指南、CI 配置）都在仓库自己的导航里，不在全局搜索里：先进仓库，再在仓库页面上找。',
    '点开顶部的搜索按钮只是弹出搜索框，页面并不会跳转。要把用户送到搜索结果，同一份计划里就要连着给出往搜索框里 input 的那一步。',
    '产品的官方文档站一般在另一个域名上，不在 github.com 里。去那里的路是先进它的文档仓库（常见是 组织名/产品名-docs），仓库主页的 README 或右侧 About 里会有那个链接。',
    '设置页的左侧导航在窄屏下会折叠为下拉菜单。',
  ].join('\n'),
};
