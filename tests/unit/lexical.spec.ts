import { describe, expect, it } from 'vitest';
import { scoreNodes } from '@/core/locator/lexical';
import type { PromptItem } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

const item = (ref: string, name: string, role = 'link', path: string[] = []): PromptItem => ({
  ref: ref as Ref,
  role,
  name,
  path,
});

describe('scoreNodes —— 中日韩查询', () => {
  /**
   * The defect this file was written for.
   *
   * `qWords` came from `q.split(' ')`, and CJK is not space-delimited, so the
   * whole query arrived as a single token and the word branch could never fire.
   * That left the `substring` branch's flat 0.7 as the only thing scoring, and
   * it fires whenever *either* string contains the other — so a two-character
   * navigation label sitting inside a nine-character question scored 0.7 while
   * the long, actually-correct name scored near zero on trigrams alone.
   *
   * The failure class matters: a verdict built on this ranking pointed at the
   * wrong element, which is L-4 — the one failure this product treats as a
   * hard zero. The offline eval still uses this scorer as its zero-model floor.
   */
  it('短导航词不得压过更长、更正确的名字', () => {
    const items = [item('e1', '文档'), item('e2', '开发者文档中心')];
    const ranked = scoreNodes('怎么进入开发者文档中心', items);
    expect(ranked[0]!.item.ref).toBe('e2');
  });

  it('中文子串匹配仍然有效', () => {
    const items = [item('e1', '账单与用量'), item('e2', '安全设置'), item('e3', '通知偏好')];
    expect(scoreNodes('账单', items)[0]!.item.ref).toBe('e1');
  });

  it('中英混排：英文词与中文双字都参与打分', () => {
    const items = [item('e1', 'AWS 控制台'), item('e2', '账户设置')];
    expect(scoreNodes('打开 AWS 控制台', items)[0]!.item.ref).toBe('e1');
  });
});

describe('scoreNodes —— 既有英文行为不得回归', () => {
  it('完全相同的名字排第一', () => {
    expect(scoreNodes('Save', [item('e1', 'Save'), item('e2', 'Cancel')])[0]!.item.ref).toBe('e1');
  });

  it('名字包含整条查询仍是强证据', () => {
    const items = [item('e1', 'Create new repository'), item('e2', 'Settings')];
    expect(scoreNodes('new repository', items)[0]!.item.ref).toBe('e1');
  });

  it('同名元素得分完全相同——打分本身不偏袒任何一个（K-6）', () => {
    const [a, b] = scoreNodes('Copy', [item('e1', 'Copy'), item('e2', 'Copy')]);
    expect(a!.score).toBe(b!.score);
  });

  it('敏感字段永不作为候选（S-03）', () => {
    const pw: PromptItem = { ...item('e1', '密码', 'textbox'), sensitive: true };
    expect(scoreNodes('密码', [pw])).toEqual([]);
  });

  it('无命中就是无命中', () => {
    expect(scoreNodes('zzzzz', [item('e1', 'Save')])).toEqual([]);
  });

});

describe('片段匹配：对齐与不对齐是两种证据', () => {
  // A first cut scaled every fragment by coverage and regressed four English
  // natural-language queries, which the eval could not see — its 20 goals are
  // all 2–4 word phrases. These pin the distinction so the next change has to
  // face it.
  it('空白对齐的片段仍是强证据（英文自然语言问句）', () => {
    const items = [item('e1', 'Stop', 'button'), item('e2', 'Create instance', 'button')];
    expect(scoreNodes('stop the running instance', items)[0]!.item.ref).toBe('e1');
  });

  it('句首与句尾的片段同样对齐', () => {
    const items = [item('e1', 'Billing', 'link'), item('e2', 'Billing history', 'link')];
    const ranked = scoreNodes('how do I get to the billing page', items);
    expect(ranked[0]!.item.ref).toBe('e1');
  });

  it('落在更长词元内部的片段被降权（中文复合词）', () => {
    const ranked = scoreNodes('怎么进入开发文档', [item('e1', '文档'), item('e2', '开发文档中心')]);
    expect(ranked[0]!.item.ref).toBe('e2');
  });
});
