import type { Plugin } from '@/agent/context/plugins';
import type { RunRecord } from '@/agent/thread/record';

/**
 * 这个站点上，这台浏览器以前走通过的路（CONTEXT.md `Memory`）。
 *
 * 引导每走完一趟就留下一条 `Run record`——目标、最后落在哪一页、走过哪几步。
 * 那份记录一直在写，却从来没有人读它：同一个站点上问第二次同类问题，产品什么
 * 都不记得，模型从零开始重新推断一遍。
 *
 * 这里读的只有**走通了的**那些：模型说到了（`model_done`），而且确实走过步骤。
 * 一次「东西本来就在这一页上」的到达不是一条路，记下来没有意义。
 *
 * 它是一个 `Plugin`，和站点 `Skill` 并排：有自己的开关，每一趟的记录里写明它
 * 当时开没开——所以「带记忆」和「不带记忆」可以分别度量，而不是一笔糊涂账。
 */

/** 按站点匹配：记录里的 `url` 是这一趟**最后**落在的那一页。 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** 记多少、说多细。都刻意小：它是提示，不是档案。 */
export const MEMORY_LIMITS = { paths: 3, steps: 3, goal: 60, step: 40 };

/** 一条走通过的路，供界面列出与删除。 */
export interface WalkedPath {
  runId: string;
  at: number;
  host: string;
  goal: string;
  url: string;
  steps: readonly string[];
}

const walked = (r: RunRecord): boolean => r.ending === 'model_done' && r.steps.length > 0;

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** 走通过的路，最近的在前。`host` 给出时只要那个站点的。 */
export function walkedPaths(records: readonly RunRecord[], host?: string): WalkedPath[] {
  return records
    .filter((r) => walked(r) && (host === undefined || hostOf(r.url) === host))
    .sort((a, b) => b.at - a.at)
    .map((r) => ({
      runId: r.runId,
      at: r.at,
      host: hostOf(r.url),
      goal: r.goal,
      url: r.url,
      steps: r.steps.map((s) => s.title),
    }));
}

/**
 * 说给模型听的那一段。
 *
 * 写成「以前走通过」而不是「这样做」：页面会改版，记下来的路只是线索，不是指令。
 * 模型照样每一步都对着当下这张元素表自己判断。
 */
export function memoryText(records: readonly RunRecord[], url: string): string | undefined {
  const host = hostOf(url);
  if (!host) return undefined;
  const paths = walkedPaths(records, host).slice(0, MEMORY_LIMITS.paths);
  if (!paths.length) return undefined;
  const lines = paths.map((p) => {
    const steps = p.steps.slice(0, MEMORY_LIMITS.steps).map((s) => cut(s, MEMORY_LIMITS.step));
    return `- 「${cut(p.goal, MEMORY_LIMITS.goal)}」：${steps.join(' → ')}`;
  });
  return [
    `这个站点上，以前在这台浏览器上走通过这些（只是线索，页面可能已经变了——照样对着这一页自己判断）：`,
    ...lines,
  ].join('\n');
}

export const memory: Plugin = {
  name: 'memory',
  defaultOn: true,
  contextFor: (url, past = []) => memoryText(past, url),
};
