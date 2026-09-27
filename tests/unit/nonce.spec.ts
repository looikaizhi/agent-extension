import { describe, expect, it } from 'vitest';
import { createNonceCache } from '@/agent/context/nonce';

/**
 * `agent/context/nonce.ts` — one nonce per snapshot instead of one per call.
 *
 * Two things have to hold at once, and they pull against each other: the same
 * page must produce the same nonce (or the prefix cache never hits), and no
 * nonce may ever appear inside the text it is wrapping (or S-01's closing tag
 * becomes forgeable). Every test here is one of those two.
 */

const counter = () => {
  let n = 0;
  return () => `nonce-${++n}`;
};

describe('context/nonce.ts · 同一张快照复用同一个 nonce', () => {
  it('1. 同一个 snapshotId 两次 → 同一个 nonce（缓存能命中的唯一前提）', () => {
    const nonceFor = createNonceCache(counter());
    expect(nonceFor('snap-1', '表内容')).toBe(nonceFor('snap-1', '表内容'));
  });

  it('2. 换了 snapshotId → 换 nonce（页面重抽过，就是另一页了）', () => {
    const nonceFor = createNonceCache(counter());
    expect(nonceFor('snap-1', 'a')).not.toBe(nonceFor('snap-2', 'a'));
  });

  it('3. 超过上限后丢最旧的，不随会话无限增长', () => {
    const nonceFor = createNonceCache(counter(), 2);
    const first = nonceFor('s1', 'x');
    nonceFor('s2', 'x');
    nonceFor('s3', 'x'); // s1 应当被挤掉
    expect(nonceFor('s1', 'x')).not.toBe(first);
    // 而没被挤掉的仍然稳定
    const s3 = nonceFor('s3', 'x');
    expect(nonceFor('s3', 'x')).toBe(s3);
  });
});

describe('context/nonce.ts · S-01 的边界一步都不能少', () => {
  it('4. 生成的 nonce 恰好出现在表里 → 重新生成，绝不返回它', () => {
    // 04 的 Gotchas：表里若已含有这个字符串，伪造的闭合标签就与真的无法区分。
    const nonceFor = createNonceCache(counter());
    expect(nonceFor('s1', '表里写着 nonce-1 和 nonce-2')).toBe('nonce-3');
  });

  it('5. 复用之前也要再查一次——缓存不是绕过这条检查的后门', () => {
    // 同一个 snapshotId 本该对应同一张表，但这条守卫是 S-01 的全部边界情况，
    // 而它只花一次 includes。表若真的变了，绝不能让它把一个匹配的字面量带进来。
    const nonceFor = createNonceCache(counter());
    const first = nonceFor('s1', '干净的表');
    expect(first).toBe('nonce-1');
    // 同一个 snapshotId，但这次的文本里出现了那个 nonce
    const again = nonceFor('s1', `这张表里混进了 ${first}`);
    expect(again).not.toBe(first);
    expect(`这张表里混进了 ${first}`).not.toContain(again);
  });

  it('6. 默认用 crypto.randomUUID，不是可预测的序列', () => {
    const nonceFor = createNonceCache();
    const a = nonceFor('s1', 'x');
    const b = nonceFor('s2', 'x');
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
