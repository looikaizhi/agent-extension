/**
 * 找出 e2e 里「睡一个固定的毫秒数，然后就去读状态」的地方。
 *
 * 这套 e2e 的偶发有一个反复出现的形状：**等到链条上的第一环，就去读第三环**。
 * 送出请求 ≠ 结果回来 ≠ 线程写完 ≠ 记录落盘。中间垫一个 `waitForTimeout(400)`
 * 在快的机器上永远够，在慢的机器上永远不够——而它红的时候看起来像玄学。
 *
 * 已经按这个形状修掉的（2026-09-22/23）：搬家后的对话、Run record 的 Plugin、
 * 运行结束即落盘、遮挡读数、刷新后的游标、trace 的开关与结束。
 *
 * 这个脚本不改任何东西，只把候选列出来，让这一类**可见**：后面跟着会轮询的读取
 * （`overlayStatus`、`waitUntil`、`pollText`）的不算，那类本来就在等事情本身。
 *
 * 用法：node tests/e2e/sleeps.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'smoke.mjs');
const lines = fs.readFileSync(file, 'utf8').split('\n');

/** 睡完之后立刻去读的、且读法本身不会等的。 */
const READS = /check\(|storage\.(local|session)\.get|DEBUG_GET_OVERLAY_STATE|requestLog\[|entriesOf\(|viewOf\(|threadOf\(/;
const POLLS = /waitUntil\(|overlayStatus\(|pollText|pollTexts|waitForEntry|locator\(/;

const found = [];
lines.forEach((line, i) => {
  const ms = line.match(/waitForTimeout\((\d+)\)/);
  if (!ms) return;
  const after = lines.slice(i + 1, i + 4).join(' ');
  if (!READS.test(after) || POLLS.test(after)) return;
  // 读的那一行未必紧挨着——显示后面三行里第一行有内容的。
  const next = lines.slice(i + 1, i + 4).find((l) => l.trim()) ?? '';
  found.push({ line: i + 1, ms: Number(ms[1]), next: next.trim().slice(0, 78) });
});

console.log(`smoke.mjs 里 ${lines.filter((l) => l.includes('waitForTimeout(')).length} 处固定等待，其中 ${found.length} 处睡完直接读状态：\n`);
for (const f of found.sort((a, b) => b.ms - a.ms)) console.log(`  ${String(f.line).padStart(5)}  ${String(f.ms).padStart(5)}ms  ${f.next}`);
console.log(
  found.length
    ? '\n逐条看一眼：读的那件事，是不是这次等待真正要等的？是就换成等它本身（waitUntil / overlayStatus）。'
    : '\n没有了。',
);
