import type { GuidePack } from '../types';

export const githubSshPack: GuidePack = {
  name: 'github',
  version: 1,
  displayName: 'GitHub 设置引导',
  description: '针对 GitHub 账号设置页的操作引导',
  match: { domains: ['github.com'] },
  // Everything a general prompt cannot carry: this site's own vocabulary.
  // Both lines are here because a live run paid for them — a journey typed
  // 「n8n-io/n8n issues」 into the global search, got a page of unrelated
  // repositories back, and spent four more hops flipping filters before
  // giving up on a repo called `vitorfhc/videt`.
  siteNotes: [
    '全局搜索按仓库名匹配，不接受"仓库名 + 你想在里面做什么"这样的词组。要打开某个仓库，输入它的 组织名/仓库名（例如 n8n-io/n8n）。',
    '仓库里的东西（issue、release、许可证、贡献指南、CI 配置）都在仓库自己的导航里，不在全局搜索里：先进仓库，再在仓库页面上找。',
    '设置页的左侧导航在窄屏下会折叠为下拉菜单。',
  ].join('\n'),
  flows: [
    {
      id: 'open-settings',
      goalAliases: ['打开设置', '进入设置', 'open settings', '账号设置'],
      steps: [
        {
          title: '打开个人菜单',
          detail: '点击右上角的头像，展开账号菜单。',
          expectedUserAction: 'click',
          target: { role: 'button', name: 'Open user account menu', nameMatch: 'contains' },
        },
        {
          title: '进入 Settings',
          detail: '在展开的菜单里选择 Settings。',
          expectedUserAction: 'click',
          target: { role: 'link', name: 'Settings', nameMatch: 'exact' },
        },
      ],
    },
    {
      id: 'find-repo-code-button',
      goalAliases: ['克隆仓库', 'clone', '下载代码', 'code 按钮'],
      steps: [
        {
          title: '找到 Code 按钮',
          detail: '仓库文件列表右上角的绿色 Code 按钮，点开后可以复制克隆地址。',
          expectedUserAction: 'click',
          target: { role: 'button', name: 'Code', nameMatch: 'exact' },
        },
      ],
    },
  ],
};
