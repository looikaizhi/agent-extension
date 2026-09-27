/**
 * 把 e2e 跑 N 轮，汇总每条检查红了几次。
 *
 * 偶发的东西一轮看不出来：红得越稀越难抓，而手工数六轮既慢又记不住。这个脚本
 * 只做一件事——**让偶发变成一张表**：哪条检查、红了几轮、每次红的时候详情是
 * 什么。有了这张表才谈得上按类下手，而不是逐条打补丁。
 *
 * 它不判定对错，也不改任何东西；smoke 自己的退出码照旧是那一轮的结论。
 *
 * 用法：
 *   node tests/e2e/flaky.mjs [轮数，默认 5]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rounds = Number(process.argv[2] ?? 5);

/** 一轮：跑完返回这一轮红掉的检查（名字 → 详情）。 */
async function run(n) {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'smoke.mjs')], { cwd: path.resolve(here, '../..') });
    let text = '';
    child.stdout.on('data', (b) => (text += b));
    child.stderr.on('data', (b) => (text += b));
    child.on('close', () => resolve(text));
  });
  const lines = out.split('\n');
  const failed = lines
    .filter((l) => l.startsWith('❌'))
    .map((l) => {
      const [name, ...rest] = l.slice(1).trim().split(' — ');
      return { name: name.trim(), detail: rest.join(' — ').slice(0, 160) };
    });
  const tally = lines.find((l) => /^\d+\/\d+ 通过$/.test(l.trim())) ?? '(这一轮没跑完)';
  console.log(`第 ${n} 轮：${tally.trim()}${failed.length ? `　红：${failed.map((f) => f.name).join('、')}` : ''}`);
  return failed;
}

const seen = new Map();
for (let i = 1; i <= rounds; i++) {
  for (const f of await run(i)) {
    const at = seen.get(f.name) ?? { times: 0, details: [] };
    at.times += 1;
    at.details.push(`第 ${i} 轮：${f.detail}`);
    seen.set(f.name, at);
  }
}

console.log(`\n${'═'.repeat(70)}\n跑了 ${rounds} 轮`);
if (seen.size === 0) {
  console.log('没有一条红过。');
} else {
  console.log('红过的检查，按频次排：\n');
  for (const [name, at] of [...seen].sort((a, b) => b[1].times - a[1].times)) {
    console.log(`  ${at.times}/${rounds}　${name}`);
    for (const d of at.details) console.log(`        ${d}`);
  }
}
