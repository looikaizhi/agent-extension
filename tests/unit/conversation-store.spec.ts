import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addEntry, readConversation, writesFailing } from '@/host/conversation-store';

/**
 * 写不下的时候会发生什么（票 04 第一层）。
 *
 * `storage.session` 是一整份配额，每个标签页的线程（连同它那张元素表）和每条
 * 对话都住在里面。写入从前是裸调的：配额一满就抛，而宿主在十三处 `await` 这个
 * 写入——于是不只是丢一条记录，整条渲染路径都断在那里，而且没有任何痕迹。
 *
 * 记录是「发生过的事」。所以这里的规矩是：**宁可丢掉最早的几条，也不丢刚发生
 * 的那条**；真的一条都写不下时，如实说出来，而不是假装写成功了。
 */

/** 一个有容量上限的 `storage.session`：装得下就装，装不下就抛。 */
function fakeSession(fits: (value: unknown) => boolean) {
  const data = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: async () => undefined },
    storage: {
      session: {
        get: async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) {
            if (!fits(v)) throw new Error('QUOTA_BYTES quota exceeded');
            data.set(k, v);
          }
        },
        remove: async (key: string) => void data.delete(key),
      },
    },
  });
  return data;
}

const said = (text: string) => ({ at: 1_000, kind: 'said' as const, text });

/** n 条记录，逐条写进去。 */
async function fill(tabId: number, n: number) {
  for (let i = 0; i < n; i++) await addEntry(tabId, said(`第 ${i} 句`));
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('对话写不下的时候', () => {
  it('装得下就照常装，什么都不丢', async () => {
    fakeSession(() => true);
    await fill(1, 12);
    const c = await readConversation(1);
    expect([c.entries.length, c.dropped, writesFailing(1)]).toEqual([12, undefined, false]);
  });

  it('装不下 → 扔掉最早的，留住刚发生的那条，并且写明扔了几条', async () => {
    // 这个「存储」最多只肯收 8 条。
    fakeSession((v) => ((v as { entries?: unknown[] }).entries?.length ?? 0) <= 8);
    await fill(2, 12);

    const c = await readConversation(2);
    expect(c.entries.length).toBeLessThanOrEqual(8);
    expect(c.dropped).toBeGreaterThan(0);
    // 留下的是最近的那几条：最后一句一定在。
    expect(c.entries.at(-1)?.text).toBe('第 11 句');
    expect(writesFailing(2)).toBe(false);
  });

  it('一条都写不下 → 不假装写成功，如实报给界面', async () => {
    fakeSession(() => false);
    await addEntry(3, said('这句写不进去'));

    expect((await readConversation(3)).entries).toEqual([]);
    expect(writesFailing(3)).toBe(true);
  });

  it('写不下之后又写得下了 → 那面旗子自己会落下', async () => {
    let room = false;
    fakeSession(() => room);
    await addEntry(4, said('先写不进去'));
    expect(writesFailing(4)).toBe(true);

    room = true;
    await addEntry(4, said('这次写得进去'));
    expect([writesFailing(4), (await readConversation(4)).entries.length]).toEqual([false, 1]);
  });

  it('写入抛出来的异常不会穿到调用方——宿主有十三处在 await 它', async () => {
    fakeSession(() => false);
    await expect(addEntry(5, said('会抛的那一条'))).resolves.toBeDefined();
  });
});
