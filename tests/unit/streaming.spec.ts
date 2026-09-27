import { describe, expect, it } from 'vitest';
import { draftTextOf } from '@/entrypoints/sidepanel/streaming';

describe('draftTextOf：模型还在写的时候，显示它写到哪了', () => {
  it('还没写到有话的字段 → 什么都不显示', () => {
    expect(draftTextOf('')).toBe('');
    expect(draftTextOf('{"previous_step":"first_plan"')).toBe('');
  });

  it('answer 写到一半 → 显示已经写出来的那一截', () => {
    expect(draftTextOf('{"answer":"这个按钮用来')).toBe('这个按钮用来');
  });

  it('写完了 → 显示整段，后面的字段不混进来', () => {
    expect(draftTextOf('{"answer":"点这里就行","refs":["e1"]}')).toBe('点这里就行');
  });

  it('转义照解：换行、引号、\\u 都不会露出原样', () => {
    expect(draftTextOf('{"answer":"第一行\\n第二行 \\"引号\\" \\u4f60好"}')).toBe('第一行\n第二行 "引号" 你好');
  });

  it('半个转义停在那里，不猜下一个字', () => {
    expect(draftTextOf('{"answer":"行末\\')).toBe('行末');
    expect(draftTextOf('{"answer":"半个 \\u4f')).toBe('半个 ');
  });

  it('指路时显示的是理由；问句显示问题', () => {
    expect(draftTextOf('{"previous_step":"worked","route":[],"why":"这条链接会带你去 issue 列表","ref":"e12"')).toBe('这条链接会带你去 issue 列表');
    expect(draftTextOf('{"question":"你说的是哪一个仓库？","wants":"text"')).toBe('你说的是哪一个仓库？');
  });

  it('answer 比 why 优先——一次回答里两者都有时，显示回答', () => {
    expect(draftTextOf('{"why":"理由","answer":"回答"}')).toBe('回答');
  });
});
