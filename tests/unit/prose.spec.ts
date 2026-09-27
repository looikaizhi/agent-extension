import { describe, expect, it } from 'vitest';
import { readProse, type ProseBlock } from '@/shared/prose';

const t = (text: string) => ({ kind: 'text', text }) as const;
const code = (text: string) => ({ kind: 'code', text }) as const;
const strong = (...parts: ({ kind: 'text'; text: string } | { kind: 'code'; text: string })[]) => ({ kind: 'strong', parts }) as const;
const para = (...lines: unknown[][]): ProseBlock => ({ kind: 'para', lines }) as ProseBlock;

describe('readProse：模型写的那一小撮 Markdown，读成结构', () => {
  it('没有任何标记的一段话，原样是一段', () => {
    expect(readProse('点这里就能打开设置。')).toEqual([para([t('点这里就能打开设置。')])]);
  });

  it('空行分段；段内的单个换行留作换行', () => {
    expect(readProse('第一行\n第二行\n\n另一段')).toEqual([para([t('第一行')], [t('第二行')]), para([t('另一段')])]);
  });

  it('首尾和多余的空行不产生空段', () => {
    expect(readProse('\n\n一段\n\n\n\n二段\n')).toEqual([para([t('一段')]), para([t('二段')])]);
    expect(readProse('')).toEqual([]);
    expect(readProse('  \n ')).toEqual([]);
  });

  it('**加粗** 与 `行内代码`', () => {
    expect(readProse('用的是 **fair-code** 许可，见 `LICENSE.md`。')).toEqual([
      para([t('用的是 '), strong(t('fair-code')), t(' 许可，见 '), code('LICENSE.md'), t('。')]),
    ]);
  });

  it('加粗里可以有行内代码；行内代码里的星号不算加粗', () => {
    expect(readProse('**打开 `settings`**')).toEqual([para([strong(t('打开 '), code('settings'))])]);
    expect(readProse('`a**b**c`')).toEqual([para([code('a**b**c')])]);
  });

  it('配不上对的标记照原文留着', () => {
    expect(readProse('2 ** 3 等于 8')).toEqual([para([t('2 ** 3 等于 8')])]);
    expect(readProse('2 ** 3 ** 2')).toEqual([para([t('2 ** 3 ** 2')])]);
    expect(readProse('只有一个 ` 反引号')).toEqual([para([t('只有一个 ` 反引号')])]);
    expect(readProse('****')).toEqual([para([t('****')])]);
  });

  it('- 、* 、• 开头的行是无序列表，数字加点或右括号是有序列表', () => {
    expect(readProse('- 甲\n* 乙\n• 丙')).toEqual([{ kind: 'list', ordered: false, items: [[[t('甲')]], [[t('乙')]], [[t('丙')]]] }]);
    expect(readProse('1. 甲\n2) 乙')).toEqual([{ kind: 'list', ordered: true, start: 1, items: [[[t('甲')]], [[t('乙')]]] }]);
  });

  it('有序列表从第几号开始，照模型写的', () => {
    expect(readProse('3. 丙\n4. 丁')).toEqual([{ kind: 'list', ordered: true, start: 3, items: [[[t('丙')]], [[t('丁')]]] }]);
  });

  it('一段引子紧跟着列表：拆成一段加一个列表', () => {
    expect(readProse('两份许可：\n- **甲**——核心\n- 乙')).toEqual([
      para([t('两份许可：')]),
      { kind: 'list', ordered: false, items: [[[strong(t('甲')), t('——核心')]], [[t('乙')]]] },
    ]);
  });

  it('列表项下面缩进的续行归这一项；缩进的子列表并进同一个列表', () => {
    expect(readProse('- 甲\n  甲的补充\n  - 甲一\n- 乙')).toEqual([
      { kind: 'list', ordered: false, items: [[[t('甲')], [t('甲的补充')]], [[t('甲一')]], [[t('乙')]]] },
    ]);
  });

  it('列表之后不缩进的行另起一段', () => {
    expect(readProse('- 甲\n结尾一句')).toEqual([{ kind: 'list', ordered: false, items: [[[t('甲')]]] }, para([t('结尾一句')])]);
  });

  it('# 标题读成加粗的一行', () => {
    expect(readProse('### 结论\n正文')).toEqual([para([strong(t('结论'))], [t('正文')])]);
  });

  it('链接、图片、表格、HTML 都照原文留着——不产生任何可点的东西，也不产生标记', () => {
    const raw = ['[文档](https://evil.example/x)', '![图](https://x/y.png)', '| a | b |', '<img src=x onerror=alert(1)>', '<b>粗</b>'];
    for (const line of raw) expect(readProse(line)).toEqual([para([t(line)])]);
  });

  it('「(1) …」这样的编号不是列表，逐行留着', () => {
    expect(readProse('请选一个：\n\n(1) n8n-io/n8n\n(2) n8n-io/n8n-docs')).toEqual([
      para([t('请选一个：')]),
      para([t('(1) n8n-io/n8n')], [t('(2) n8n-io/n8n-docs')]),
    ]);
  });

  it('真机上的一条回答（t13 问答冒烟）', () => {
    const answer =
      '这个仓库用的是 **fair-code** 许可，具体条款由两份自定义（非标准 OSI）许可组成：\n\n' +
      '- **Sustainable Use License**（可持续使用许可）——适用于核心代码\n' +
      '- **n8n Enterprise License**（n8n 企业许可）——适用于企业版（EE）目录下的代码\n\n' +
      '仓库根目录里有对应的许可证文件 `LICENSE.md` 和 `LICENSE_EE.md`。';
    expect(readProse(answer)).toEqual([
      para([t('这个仓库用的是 '), strong(t('fair-code')), t(' 许可，具体条款由两份自定义（非标准 OSI）许可组成：')]),
      {
        kind: 'list',
        ordered: false,
        items: [
          [[strong(t('Sustainable Use License')), t('（可持续使用许可）——适用于核心代码')]],
          [[strong(t('n8n Enterprise License')), t('（n8n 企业许可）——适用于企业版（EE）目录下的代码')]],
        ],
      },
      para([t('仓库根目录里有对应的许可证文件 '), code('LICENSE.md'), t(' 和 '), code('LICENSE_EE.md'), t('。')]),
    ]);
  });
});
