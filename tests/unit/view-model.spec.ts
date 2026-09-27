import { describe, expect, it } from 'vitest';
import { describeProviderError, ProviderError } from '@/agent/provider/transport';
import { type CallRecord, summarizeCost } from '@/entrypoints/sidepanel/view-model';

/**
 * Pure logic behind `App.tsx`: the cost line, and how a provider error is said.
 * `App.tsx` itself depends on `chrome.*` and React rendering and is proven
 * only in the e2e suite (08) — see that file's README for why. Everything
 * under test here has no side effects, so it keeps a real red→green loop.
 */

describe('summarizeCost', () => {
  it('12. 空历史 → 全零，estimated 为 false', () => {
    const s = summarizeCost([]);
    expect(s).toEqual({
      totalCalls: 0,
      primaryCalls: 0,
      repairCalls: 0,
      unknownCostCalls: 0,
      prompt: 0,
      completion: 0,
      total: 0,
      estimated: false,
    });
  });

  it('13. 一次成功的主调用（真实 usage）→ token 累加，estimated 为 false', () => {
    const calls: CallRecord[] = [{ kind: 'primary', usage: { prompt: 100, completion: 50, total: 150, estimated: false } }];
    const s = summarizeCost(calls);
    expect(s.totalCalls).toBe(1);
    expect(s.primaryCalls).toBe(1);
    expect(s.repairCalls).toBe(0);
    expect(s.prompt).toBe(100);
    expect(s.completion).toBe(50);
    expect(s.total).toBe(150);
    expect(s.estimated).toBe(false);
  });

  it('14. 主调用解析失败 + 一次修复调用 → 两次调用分开计数，token 分别累加', () => {
    const calls: CallRecord[] = [
      { kind: 'primary', usage: { prompt: 100, completion: 20, total: 120, estimated: false } },
      { kind: 'repair', usage: { prompt: 30, completion: 10, total: 40, estimated: false } },
    ];
    const s = summarizeCost(calls);
    expect(s.totalCalls).toBe(2);
    expect(s.primaryCalls).toBe(1);
    expect(s.repairCalls).toBe(1);
    expect(s.prompt).toBe(130);
    expect(s.completion).toBe(30);
    expect(s.total).toBe(160);
  });

  it('14b. 引导那条路的用量是一份合计 → 兄弟调用记 merged，计数照算，但不冒充「未返回用量」', () => {
    // 引导走 `runGuideToEnd`，修复轮在它内部发生，端点报回来的是主调用与修复
    // 合在一起的一个数。把兄弟那条记成 null 会点亮「N 次调用未返回用量」这句
    // 警告——而用量并没有丢，只是记在了另一条上。两种「没有数字」要分开。
    const calls: CallRecord[] = [
      { kind: 'primary', usage: { prompt: 300, completion: 60, total: 360, estimated: false } },
      { kind: 'repair', usage: 'merged' },
    ];
    const s = summarizeCost(calls);
    expect(s.totalCalls).toBe(2);
    expect(s.primaryCalls).toBe(1);
    expect(s.repairCalls).toBe(1);
    expect(s.unknownCostCalls).toBe(0);
    expect(s.prompt).toBe(300);
    expect(s.total).toBe(360);
    expect(s.estimated).toBe(false);
  });

  it('15. 任意一次调用的 usage 是估算值 → 合并结果 estimated 为 true（即使其它调用是真实值）', () => {
    const calls: CallRecord[] = [
      { kind: 'primary', usage: { prompt: 10, completion: 5, total: 15, estimated: false } },
      { kind: 'repair', usage: { prompt: 3, completion: 2, total: 5, estimated: true } },
    ];
    expect(summarizeCost(calls).estimated).toBe(true);
  });

  it('16. 已发出但失败的调用（usage: null）→ 计入 totalCalls/primaryCalls，不计入 token 总数，计入 unknownCostCalls', () => {
    const calls: CallRecord[] = [{ kind: 'primary', usage: null }];
    const s = summarizeCost(calls);
    expect(s.totalCalls).toBe(1);
    expect(s.primaryCalls).toBe(1);
    expect(s.unknownCostCalls).toBe(1);
    expect(s.prompt).toBe(0);
    expect(s.completion).toBe(0);
    expect(s.total).toBe(0);
  });

  it('17. 失败的主调用之后又有一次成功的修复调用 → 各自记账互不覆盖', () => {
    const calls: CallRecord[] = [
      { kind: 'primary', usage: null },
      { kind: 'repair', usage: { prompt: 20, completion: 8, total: 28, estimated: true } },
    ];
    const s = summarizeCost(calls);
    expect(s.totalCalls).toBe(2);
    expect(s.unknownCostCalls).toBe(1);
    expect(s.prompt).toBe(20);
    expect(s.estimated).toBe(true);
  });
});

describe('describeProviderError', () => {
  it('18. ProviderError → 原样返回其 message（已经是面向用户的中文文案）', () => {
    const e = new ProviderError('Key 被拒绝（HTTP 401）。', 'auth', false);
    expect(describeProviderError(e)).toBe('Key 被拒绝（HTTP 401）。');
  });

  it('19. 非 ProviderError（意料之外的异常）→ 仍给出可读文案，不泄露 [object Object] 之类的东西', () => {
    expect(describeProviderError(new Error('boom'))).toContain('boom');
    expect(describeProviderError('a bare string')).toContain('a bare string');
    expect(describeProviderError(null)).not.toContain('[object');
  });
});
