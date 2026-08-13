import { describe, expect, it } from 'vitest';
import { MAX_CANDIDATES, rankCandidates, scoreNodes } from '@/core/locator/lexical';
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
   * The failure class matters: `rankCandidates` returned `unique` on the wrong
   * element, which is L-4 — the one failure this product treats as a hard zero.
   */
  it('短导航词不得压过更长、更正确的名字', () => {
    const items = [item('e1', '文档'), item('e2', '开发者文档中心')];
    const ranked = scoreNodes('怎么进入开发者文档中心', items);
    expect(ranked[0]!.item.ref).toBe('e2');
  });

  it('不再把错的那个判成唯一命中（L-4 → 至多 L-2）', () => {
    const items = [item('e1', '文档'), item('e2', '开发者文档中心')];
    const r = rankCandidates('怎么进入开发文档', items);
    if (r.kind === 'unique') expect(r.item.ref).toBe('e2');
    else if (r.kind === 'ambiguous') expect(r.items.map((i) => i.ref)).toContain('e2');
    else expect.unreachable('中文查询不应无命中');
  });

  it('中文子串匹配仍然有效', () => {
    const items = [item('e1', '账单与用量'), item('e2', '安全设置'), item('e3', '通知偏好')];
    const r = rankCandidates('账单', items);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.item.ref).toBe('e1');
  });

  it('中英混排：英文词与中文双字都参与打分', () => {
    const items = [item('e1', 'AWS 控制台'), item('e2', '账户设置')];
    const r = rankCandidates('打开 AWS 控制台', items);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.item.ref).toBe('e1');
  });
});

describe('scoreNodes —— 既有英文行为不得回归', () => {
  it('完全相同的名字得满分', () => {
    const r = rankCandidates('Save', [item('e1', 'Save'), item('e2', 'Cancel')]);
    expect(r.kind).toBe('unique');
  });

  it('名字包含整条查询仍是强证据', () => {
    const items = [item('e1', 'Create new repository'), item('e2', 'Settings')];
    const r = rankCandidates('new repository', items);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.item.ref).toBe('e1');
  });

  it('同名元素永远是 ambiguous，绝不挑一个（K-6）', () => {
    const items = [item('e1', 'Copy'), item('e2', 'Copy')];
    const r = rankCandidates('Copy', items);
    expect(r.kind).toBe('ambiguous');
  });

  it('敏感字段永不作为候选（S-03）', () => {
    const pw: PromptItem = { ...item('e1', '密码', 'textbox'), sensitive: true };
    expect(scoreNodes('密码', [pw])).toEqual([]);
  });

  it('无命中就是无命中', () => {
    expect(rankCandidates('zzzzz', [item('e1', 'Save')]).kind).toBe('none');
  });

  it('候选上限仍然是 3', () => {
    expect(MAX_CANDIDATES).toBe(3);
  });
});

describe('片段匹配：对齐与不对齐是两种证据', () => {
  // A first cut scaled every fragment by coverage and regressed four English
  // natural-language queries, which the eval could not see — its 20 goals are
  // all 2–4 word phrases. These pin the distinction so the next change has to
  // face it.
  it('空白对齐的片段仍是强证据（英文自然语言问句）', () => {
    const items = [item('e1', 'Stop', 'button'), item('e2', 'Create instance', 'button')];
    const r = rankCandidates('stop the running instance', items);
    expect(r.kind).toBe('unique');
    if (r.kind === 'unique') expect(r.item.ref).toBe('e1');
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
