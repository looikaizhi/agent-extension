import type { GuidePack } from '../types';

export const githubSshPack: GuidePack = {
  name: 'github',
  version: 1,
  displayName: 'GitHub 设置引导',
  description: '针对 GitHub 账号设置页的操作引导',
  match: { domains: ['github.com'] },
  siteNotes: '设置页的左侧导航在窄屏下会折叠为下拉菜单。',
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
