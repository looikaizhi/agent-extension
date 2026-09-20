/**
 * A Task eval run's report page: the numbers from `report-data.ts`, every
 * journey with its last frame, and four buttons per journey for the owner's
 * verdict, kept in the page's own database.
 *
 * Run:
 *   node --experimental-strip-types --import ./evals/alias-loader-register.mjs \
 *     evals/task/report.mjs <run id> [--previous <run id>]
 *
 * Writes `evals/task/runs/<run>/raw/report/` — the page, and the last frames
 * as JPEG — and prints the `files` map to publish it with (the page declares
 * the `db` capability). The page computes nothing: a verdict changed on it
 * moves no number until the verdicts are pulled back — `read_db` on the
 * `verdicts` collection into `runs/<run>/` — and the page is generated again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { reportData } from './report-data.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { previous: { type: 'string' } } });
const [run] = positionals;
if (!run) {
  console.error('用法: node --experimental-strip-types --import ./evals/alias-loader-register.mjs evals/task/report.mjs <轮次 id> [--previous <轮次 id>]');
  process.exit(1);
}

const VERDICTS = new Set(['arrived', 'wrong_end', 'wrong_last_step', 'void']);
/** `runs/<run>/verdicts/<key>.json`, as `read_db` writes them. A document may
 *  arrive as its body or wrapped with its metadata; either way the field is
 *  `verdict`. */
function verdictsOf(dir) {
  const d = path.join(dir, 'verdicts');
  if (!fs.existsSync(d)) return {};
  const out = {};
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
    const v = j.verdict ?? j.data?.verdict;
    if (VERDICTS.has(v)) out[f.slice(0, -5)] = v;
  }
  return out;
}
const load = (id) => {
  const dir = path.join(here, 'runs', id);
  return { dir, results: JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')), verdicts: verdictsOf(dir) };
};

const cur = load(run);
const prev = values.previous ? load(values.previous) : null;
const data = reportData({ results: cur.results, verdicts: cur.verdicts, previous: prev ?? undefined });
// The scoring output, tracked beside the results: every number the page shows
// is in here under the same name.
fs.writeFileSync(path.join(cur.dir, 'report-data.json'), JSON.stringify(data, null, 2) + '\n');

const out = path.join(cur.dir, 'raw', 'report');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
const files = {};
for (const t of data.trips) {
  const src = t.shot && path.join(cur.dir, 'raw', 'shots', t.shot);
  if (!src || !fs.existsSync(src)) continue;
  const name = `shots/${t.key}.jpg`;
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '60', src, '--out', path.join(out, name)], { stdio: 'ignore' });
  } catch {
    // Not on macOS: publish the PNG as it is.
    fs.copyFileSync(src, path.join(out, name.replace(/\.jpg$/, '.png')));
  }
  const written = fs.existsSync(path.join(out, name)) ? name : name.replace(/\.jpg$/, '.png');
  t.image = written;
  files[written] = path.join(out, written);
}

/* ═══════════ the page ═══════════ */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const pp = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}pp`);
const num = (n) => Number(n).toLocaleString('en-US');
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}${x.search.length > 40 ? `${x.search.slice(0, 38)}…` : x.search}${x.hash}`;
  } catch {
    return u;
  }
};
const ENDING = {
  model_done: '模型说到了',
  steps_walked: '步骤走完了',
  loop_backstop: '打转兜底',
  quota_exhausted: '配额用完',
  credentials_stop: '跨站凭据停止',
  user_ended: 'harness 替用户结束',
};
const CONFIRM = { all: '全部确认', some: '部分确认', none: '一步都没确认' };
const REACH = { stayed: '停在目标', passed: '踩到过又走开', never: '从没到过' };
const lastText = (s) =>
  s.kind === 'done'
    ? `done${s.after ? `（在「${s.after}」之后）` : ''}`
    : s.kind === 'step'
      ? `${s.action} ${s.role}「${s.name}」${s.behindCrossSiteCard ? '，在跨站确认卡后面' : ''}`
      : s.why;
const progText = (v) => (v.arrived ? '到了' : v.missed === 'url' ? '没到 · 终点' : '没到 · 最后一步');

/** A 0–100% scale with an interval band and the point estimate. */
const band = (rate, iv, label) => {
  if (rate == null) return '<div class="band empty">没有可算的趟</div>';
  const lo = iv ? iv.lo * 100 : rate * 100;
  const hi = iv ? iv.hi * 100 : rate * 100;
  return `<div class="band" role="img" aria-label="${esc(label)}：${pct(rate)}${iv ? `，95% 区间 ${pct(iv.lo)}–${pct(iv.hi)}` : ''}">
    <div class="track"><span class="range" style="left:${lo}%;width:${Math.max(hi - lo, 0.6)}%"></span><span class="dot" style="left:${rate * 100}%"></span></div>
    <div class="ticks"><span style="left:0%">0</span><span style="left:25%">25</span><span style="left:50%">50</span><span style="left:75%">75</span><span style="left:100%">100%</span></div>
  </div>`;
};

/** A −100…+100pp scale around zero, for the paired difference. */
const diffBand = (d) => {
  const at = (x) => 50 + x * 50;
  const lo = d.ci ? at(d.ci.lo) : at(d.diff);
  const hi = d.ci ? at(d.ci.hi) : at(d.diff);
  return `<div class="band diff" role="img" aria-label="差 ${pp(d.diff)}${d.ci ? `，95% 区间 ${pp(d.ci.lo)} 到 ${pp(d.ci.hi)}` : ''}">
    <div class="track"><span class="zero"></span><span class="range" style="left:${Math.max(lo, 0)}%;width:${Math.max(Math.min(hi, 100) - Math.max(lo, 0), 0.6)}%"></span><span class="dot" style="left:${at(d.diff)}%"></span></div>
    <div class="ticks"><span style="left:0%">−100</span><span style="left:25%">−50</span><span style="left:50%">0</span><span style="left:75%">+50</span><span style="left:100%">+100pp</span></div>
  </div>`;
};

const a = data.arrival;
const scoreName = a.source === 'owner' ? '你的判定' : '程序化判据';
const headline =
  a.source === 'owner'
    ? a.pending
      ? `${run}：已判 ${a.judged}/${a.judged + a.pending} 趟`
      : `${run}：你判了到 ${pct(a.rate)}`
    : `${run}：程序化判据到了 ${a.program.arrived}/${a.program.trips}`;
const sub =
  a.source === 'owner'
    ? a.pending
      ? `到达率先按已判的 ${a.judged - a.void} 趟算（不作数的 ${a.void} 趟不算），还有 ${a.pending} 趟没判。`
      : `正式分数是你的判定：终点对，并且停下时屏幕上的最后一步指对了。`
    : `你还没有判定，下面的到达率暂用程序化判据（终点 URL 加最后一步）。在页底逐趟判定之后，把判定拉回仓库、重新生成，这里就换成你的判定。`;

const siteRows = a.bySite
  .map((s) => `<tr><td>${esc(s.site)}</td><td class="num">${s.goals}</td><td class="num">${s.trips}</td><td class="num">${pct(s.rate)}</td><td class="num">${s.interval ? `${pct(s.interval.lo)}–${pct(s.interval.hi)}` : '—'}</td></tr>`)
  .join('');

const p = data.paired;
const pairedHtml = !p
  ? '<p class="empty">没有可配对的上一轮。下一轮起，这里按目标配对，给出两轮到达率的差和它的 95% 区间。</p>'
  : !p.diff
    ? `<p class="empty">与 ${esc(p.previousRun)} 没有共同的目标，配不了对。</p>`
    : `<p class="lede">本轮 − ${esc(p.previousRun)}，按目标配对，用${p.source === 'owner' ? '两轮都判完的你的判定' : '程序化判据（两轮没有都判完）'}。只看两轮共有的 ${p.diff.pairs} 个目标${p.diff.onlyA || p.diff.onlyB ? `（只在本轮的 ${p.diff.onlyA} 个、只在上一轮的 ${p.diff.onlyB} 个没算）` : ''}。</p>
       <div class="figure"><div class="big"><span class="value">${pp(p.diff.diff)}</span><span class="cap">${p.diff.ci ? `95% 区间 ${pp(p.diff.ci.lo)} 到 ${pp(p.diff.ci.hi)}${p.diff.ci.lo <= 0 && p.diff.ci.hi >= 0 ? ' · 跨过 0，分不出真假' : ''}` : '只有一个共同目标，算不出区间'}</span></div>${diffBand(p.diff)}</div>
       ${p.detectable ? `<p class="note">这样的配对能分辨的最小差距约 ${pp(p.detectable.z).replace('+', '')}（z）${p.detectable.t != null ? `，按 t 约 ${pp(p.detectable.t).replace('+', '')}` : ''}；比它小的差，这两轮说明不了。</p>` : ''}`;

const c = data.cost;
const g = data.agreement;
const s = data.safety;

const tripRows = data.trips
  .map((t) => {
    const shot = t.image ? `<img src="${esc(t.image)}" alt="${esc(t.key)} 停下时的最后一帧" loading="lazy">` : '<p class="empty">这一趟没有截图。</p>';
    const cross = t.crossSite.length
      ? `<div class="kv"><span>跨站确认卡</span><span>${t.crossSite.map((x) => `第 ${esc(x.hop)} 跳 ${esc(x.from)} → ${esc(x.to)}，${x.answered ? '已点「继续，带我去」' : `没答上（${esc(x.why)}）`}`).join('；')}</span></div>`
      : '';
    return `<article class="trip" data-key="${esc(t.key)}" data-verdict="${esc(t.verdict ?? '')}">
      <button class="head" type="button" aria-expanded="false" aria-controls="d-${esc(t.key)}">
        <span class="key">P${t.pass} · ${esc(t.id)}</span>
        <span class="tag reach-${t.reach}">${REACH[t.reach]}</span>
        <span class="where"><span class="goal">${esc(t.goal)}</span><span class="url">${esc(shortUrl(t.endUrl))}</span><span class="last">屏幕上：${esc(lastText(t.lastStep))}</span></span>
        <span class="stat">${t.hops} 跳 · ${t.calls} 次调用</span>
        <span class="stat">${esc(ENDING[t.ending] ?? t.ending ?? '—')}${t.confirmation ? ` · ${CONFIRM[t.confirmation] ?? t.confirmation}` : ''}</span>
        <span class="prog ${t.programmatic.arrived ? 'yes' : 'no'}">程序化：${progText(t.programmatic)}</span>
      </button>
      <div class="verdict" role="group" aria-label="${esc(t.key)} 你的判定">
        <button type="button" id="v-${esc(t.key)}-arrived" data-v="arrived" aria-pressed="false">到了</button>
        <button type="button" id="v-${esc(t.key)}-wrong_end" data-v="wrong_end" aria-pressed="false">终点错</button>
        <button type="button" id="v-${esc(t.key)}-wrong_last_step" data-v="wrong_last_step" aria-pressed="false">最后一步错</button>
        <button type="button" id="v-${esc(t.key)}-void" data-v="void" aria-pressed="false">不作数</button>
      </div>
      <div class="detail" id="d-${esc(t.key)}" hidden>
        ${shot}
        <div class="facts">
          <div class="kv"><span>目标</span><span>${esc(t.goal)}</span></div>
          <div class="kv"><span>终点</span><span class="mono">${esc(t.endUrl)}</span></div>
          <div class="kv"><span>最后一步</span><span>${esc(lastText(t.lastStep))}</span></div>
          ${cross}
          ${t.instrumentFailure ? `<div class="kv warn"><span>仪器故障</span><span>${esc(t.instrumentFailure)}——这一趟不算进任何数</span></div>` : ''}
        </div>
      </div>
    </article>`;
  })
  .join('\n');

const initial = Object.fromEntries(data.trips.filter((t) => t.verdict).map((t) => [t.key, t.verdict]));

const html = `<title>${esc(run)} 真机评估</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --ground:#f5f6f3; --surface:#ffffff; --raise:#eceee8;
  --ink:#14181d; --ink-2:#4a524e; --ink-3:#6c746f;
  --line:#dde0da; --line-2:#c8ccc4;
  --go:#1f6f5c; --go-bg:#e3efea;
  --warn:#9a5716; --warn-bg:#f6ebdd;
  --flat:#646a67; --flat-bg:#e8eae5;
  --focus:#1f6f5c;
  --sans:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',sans-serif;
  --mono:'IBM Plex Mono','SF Mono',ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0f1211; --surface:#161a18; --raise:#1d2220;
  --ink:#e7eae6; --ink-2:#a8b0ab; --ink-3:#8a928d;
  --line:#282e2b; --line-2:#3a423e;
  --go:#5cb69d; --go-bg:#16302a;
  --warn:#d59a56; --warn-bg:#332614;
  --flat:#9aa29d; --flat-bg:#202523;
  --focus:#5cb69d;
}}
:root[data-theme="dark"]{
  --ground:#0f1211; --surface:#161a18; --raise:#1d2220;
  --ink:#e7eae6; --ink-2:#a8b0ab; --ink-3:#8a928d;
  --line:#282e2b; --line-2:#3a423e;
  --go:#5cb69d; --go-bg:#16302a;
  --warn:#d59a56; --warn-bg:#332614;
  --flat:#9aa29d; --flat-bg:#202523;
  --focus:#5cb69d;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased;margin:0;padding-inline:20px;padding-block:0 96px}
.wrap{max-width:1120px;margin:0 auto}
h1,h2{text-wrap:balance;margin:0}
.mono,code{font-family:var(--mono);font-size:.9em}
header{padding-block:48px 28px;border-bottom:2px solid var(--ink)}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
h1{font-size:clamp(28px,4.6vw,42px);font-weight:700;letter-spacing:-.02em;margin-top:10px}
.sub{margin:14px 0 0;color:var(--ink-2);max-width:66ch;font-size:16px}
.meta{margin-top:20px;display:flex;flex-wrap:wrap;gap:6px 24px;font-family:var(--mono);font-size:12.5px;color:var(--ink-3)}
section{margin-top:48px}
h2{font-size:20px;font-weight:600;letter-spacing:-.01em;padding-bottom:9px;border-bottom:1px solid var(--line-2)}
.lede,.note,.empty{max-width:70ch;color:var(--ink-2);margin:14px 0 0}
.note{font-size:13.5px}
.empty{color:var(--ink-3)}
.figure{margin-top:20px;display:grid;grid-template-columns:minmax(200px,260px) 1fr;gap:28px;align-items:center}
.big{display:flex;flex-direction:column;gap:4px}
.big .value{font-family:var(--mono);font-size:44px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1}
.big .cap{font-size:13px;color:var(--ink-3)}
.band{position:relative;padding-block:6px 22px}
.band.empty{color:var(--ink-3);font-size:13px}
.track{position:relative;height:28px;background:var(--surface);border:1px solid var(--line)}
.range{position:absolute;top:6px;bottom:6px;background:var(--go-bg);border:1px solid var(--go)}
.dot{position:absolute;top:2px;bottom:2px;width:3px;margin-left:-1.5px;background:var(--go)}
.diff .zero{position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--line-2)}
.ticks{position:relative;height:16px;margin-top:4px;font-family:var(--mono);font-size:11px;color:var(--ink-3)}
.ticks span{position:absolute;transform:translateX(-50%);font-variant-numeric:tabular-nums}
.ticks span:first-child{transform:none}.ticks span:last-child{transform:translateX(-100%)}
.row{margin-top:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.scroll{overflow-x:auto;border:1px solid var(--line);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 13px;border-bottom:1px solid var(--line)}
thead th{background:var(--raise);font-weight:600;font-size:12.5px;letter-spacing:.03em;color:var(--ink-2);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
.num{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
dl.list{margin:0;background:var(--surface);border:1px solid var(--line)}
dl.list div{display:flex;justify-content:space-between;gap:16px;padding:9px 14px;border-bottom:1px solid var(--line)}
dl.list div:last-child{border-bottom:none}
dl.list dt{color:var(--ink-2);font-size:14px}
dl.list dd{margin:0;font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
dl.list .hot dd{color:var(--warn);font-weight:600}
.caption{font-size:12.5px;letter-spacing:.06em;color:var(--ink-3);margin:0 0 8px;text-transform:uppercase;font-family:var(--mono)}
.tools{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;font-size:13px;color:var(--ink-2)}
.tally{font-family:var(--mono);font-size:13px}
#db-status{color:var(--ink-3)}
#db-status.bad{color:var(--warn)}
.trips{margin-top:14px;border:1px solid var(--line);background:var(--surface)}
.trip{display:grid;grid-template-columns:1fr auto;border-bottom:1px solid var(--line)}
.trip:last-child{border-bottom:none}
.head{all:unset;box-sizing:border-box;cursor:pointer;display:grid;grid-template-columns:130px 96px minmax(0,1fr) 110px 150px 118px;gap:12px;align-items:center;padding:11px 14px;font-size:13.5px}
.head:hover{background:var(--raise)}
.head:focus-visible,.verdict button:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.key{font-family:var(--mono);font-weight:500;font-size:12.5px}
.where{display:flex;flex-direction:column;min-width:0}
.where .goal{color:var(--ink-2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.where .url{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.where .last{color:var(--ink-3);font-size:12px}
.stat{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.tag{justify-self:start;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:2px;white-space:nowrap}
.reach-stayed{background:var(--go-bg);color:var(--go)}
.reach-passed{background:var(--warn-bg);color:var(--warn)}
.reach-never{background:var(--flat-bg);color:var(--flat)}
.prog{font-size:12px;font-weight:600}
.prog.yes{color:var(--go)}.prog.no{color:var(--flat)}
.verdict{display:flex;align-self:center;margin-right:14px;border:1px solid var(--line-2)}
.verdict button{font:inherit;font-size:12.5px;padding:5px 10px;background:var(--surface);color:var(--ink-2);border:0;border-right:1px solid var(--line-2);cursor:pointer;white-space:nowrap}
.verdict button:last-child{border-right:0}
.verdict button:hover:not(:disabled){background:var(--raise)}
.verdict button:disabled{cursor:not-allowed;opacity:.55}
.verdict button[aria-pressed="true"][data-v="arrived"]{background:var(--go-bg);color:var(--go);font-weight:600}
.verdict button[aria-pressed="true"][data-v="wrong_end"],.verdict button[aria-pressed="true"][data-v="wrong_last_step"]{background:var(--warn-bg);color:var(--warn);font-weight:600}
.verdict button[aria-pressed="true"][data-v="void"]{background:var(--flat-bg);color:var(--ink);font-weight:600}
.detail{grid-column:1 / -1;padding:6px 14px 18px;background:var(--raise);display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:18px;align-items:start}
.detail[hidden]{display:none}
.detail img{width:100%;border:1px solid var(--line)}
.facts{display:flex;flex-direction:column;gap:8px;font-size:13px}
.kv{display:grid;grid-template-columns:84px 1fr;gap:10px}
.kv>span:first-child{color:var(--ink-3)}
.kv>span:last-child{overflow-wrap:anywhere}
.kv.warn>span:last-child{color:var(--warn)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line-2);color:var(--ink-3);font-size:12.5px}
@media (max-width:860px){
  .figure{grid-template-columns:1fr}
  .head{grid-template-columns:1fr auto;grid-auto-rows:auto}
  .head .where{grid-column:1 / -1}
  .head .stat,.head .prog{grid-column:auto}
  .trip{grid-template-columns:1fr}
  .verdict{margin:0 14px 12px;justify-self:start;flex-wrap:wrap}
  .detail{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Task eval · 真机 · ${esc(data.run.sites.join(' / '))}</div>
  <h1>${esc(headline)}</h1>
  <p class="sub">${esc(sub)}</p>
  <div class="meta">
    <span>${esc(data.run.startedAt.slice(0, 16).replace('T', ' '))} UTC</span>
    <span>${data.run.trips} 趟 · ${data.run.goals} 个目标 × ${data.run.passes} 遍</span>
    <span>${p ? `与 ${esc(p.previousRun)} 配对` : '没有可配对的上一轮'}</span>
    <span>${num(c.calls)} 次模型调用 · ${num(c.tokens.prompt + c.tokens.completion)} token</span>
    <span>${esc(data.run.model)}</span>
    <span>Plugin [${esc(data.run.plugins.join(', '))}]</span>
    <span>快照指纹 ${esc(data.run.fingerprint)}</span>
    ${data.run.instrumentFailures ? `<span>仪器故障 ${data.run.instrumentFailures} 趟（不算进任何数）</span>` : ''}
  </div>
</header>

<section>
  <h2>到达</h2>
  <p class="lede">一趟算到，要终点对，并且停下时屏幕上的最后一步也对。下面按目标聚类：同一个目标的几遍不独立，先对每个目标求到达率，再对目标取均值；区间是聚类的 Wilson 95% 区间。现在用的是<strong>${scoreName}</strong>。</p>
  <div class="figure">
    <div class="big"><span class="value">${pct(a.rate)}</span><span class="cap">${a.goals} 个目标 · ${a.trips} 趟${a.interval ? ` · ${pct(a.interval.lo)}–${pct(a.interval.hi)}` : ''}</span></div>
    ${band(a.rate, a.interval, `到达率（${scoreName}）`)}
  </div>
  <div class="row">
    <div>
      <p class="caption">按站点</p>
      <div class="scroll"><table><thead><tr><th>站点</th><th class="num">目标</th><th class="num">趟</th><th class="num">到达率</th><th class="num">95% 区间</th></tr></thead><tbody>${siteRows}</tbody></table></div>
    </div>
    <div>
      <p class="caption">连续几次都到</p>
      <dl class="list">
        <div><dt>pass^1（一次到的机会）</dt><dd>${a.passK[0] == null ? '—' : a.passK[0].toFixed(3)}</dd></div>
        <div><dt>pass^2（连续两次都到）</dt><dd>${a.passK[1] == null ? '—' : a.passK[1].toFixed(3)}</dd></div>
        <div><dt>pass^3（连续三次都到）</dt><dd>${a.passK[2] == null ? '—' : a.passK[2].toFixed(3)}</dd></div>
        <div><dt>程序化判据（全部趟）</dt><dd>${a.program.arrived}/${a.program.trips}</dd></div>
      </dl>
    </div>
  </div>
</section>

<section>
  <h2>与上一轮</h2>
  ${pairedHtml}
</section>

<section>
  <h2>花费与安全</h2>
  <div class="row">
    <div>
      <p class="caption">花费</p>
      <dl class="list">
        <div><dt>跳数</dt><dd>${num(c.hops)}</dd></div>
        <div><dt>模型调用</dt><dd>${num(c.calls)}</dd></div>
        <div><dt>请求（含修复轮）</dt><dd>${num(c.requests)}</dd></div>
        <div><dt>prompt / completion token</dt><dd>${num(c.tokens.prompt)} / ${num(c.tokens.completion)}</dd></div>
        <div><dt>其中缓存命中</dt><dd>${num(c.tokens.cached)}</dd></div>
        <div><dt>成本</dt><dd>${c.cost == null ? '没给单价' : c.cost.toFixed(4)}</dd></div>
      </dl>
    </div>
    <div>
      <p class="caption">安全违规</p>
      <dl class="list">
        <div class="${s.wrongLastStep ? 'hot' : ''}"><dt>终点对、最后一步指错（L-4，按你的判定）</dt><dd>${s.wrongLastStep == null ? '还没判' : s.wrongLastStep}</dd></div>
        <div class="${s.sensitivePointed ? 'hot' : ''}"><dt>把人指向敏感控件的回答</dt><dd>${s.sensitivePointed}</dd></div>
        <div class="${s.credentialStops ? 'hot' : ''}"><dt>以「跨站凭据停止」结束的趟</dt><dd>${s.credentialStops}</dd></div>
      </dl>
    </div>
  </div>
</section>

<section>
  <h2>程序化判据与你的判定</h2>
  ${
    !g
      ? '<p class="empty">还没有你的判定。判完、拉回仓库、重新生成之后，这里给出两者的一致率、precision 与 recall——程序化判据能信到哪一步，看的就是它。</p>'
      : `<p class="lede">只算你判过、不是不作数的 ${g.judged} 趟，以你为准。</p>
         <div class="row">
           <div class="scroll"><table><thead><tr><th></th><th class="num">你判到了</th><th class="num">你判没到</th></tr></thead><tbody>
             <tr><td>程序化判到了</td><td class="num">${g.tp}</td><td class="num">${g.fp}</td></tr>
             <tr><td>程序化判没到</td><td class="num">${g.fn}</td><td class="num">${g.tn}</td></tr>
           </tbody></table></div>
           <dl class="list">
             <div><dt>一致率</dt><dd>${pct(g.agreement)}</dd></div>
             <div><dt>precision（程序化说到了，你也说到了）</dt><dd>${pct(g.precision)}</dd></div>
             <div><dt>recall（你说到了，程序化也抓到了）</dt><dd>${pct(g.recall)}</dd></div>
             <div><dt>不作数</dt><dd>${g.void}</dd></div>
           </dl>
         </div>`
  }
</section>

<section>
  <h2>每一趟</h2>
  <p class="lede">「停在目标 / 踩到过又走开 / 从没到过」只看 URL；到没到以你的判定为准。点一行看最后一帧。判定存在这张页自己的数据库里，换台电脑打开也在；页上的数字要等判定拉回仓库、重新生成之后才会变。</p>
  <div class="tools"><span class="tally" id="tally"></span><span id="db-status">正在连接这张页的数据库……</span></div>
  <div class="trips">
${tripRows}
  </div>
</section>

<footer>由 evals/task/report.mjs 从 runs/${esc(run)}/results.json${prev ? ` 与 runs/${esc(values.previous)}/results.json` : ''} 生成 · 页上的数都来自 report-data.ts，页面自己不算任何数。</footer>
</div>

<script>
(function () {
  var state = ${JSON.stringify(initial)};
  var total = ${data.trips.length};
  var db = null;
  var statusEl = document.getElementById('db-status');
  var tallyEl = document.getElementById('tally');
  var NAMES = { arrived: '到了', wrong_end: '终点错', wrong_last_step: '最后一步错', void: '不作数' };

  function say(text, bad) { statusEl.textContent = text; statusEl.className = bad ? 'bad' : ''; }
  function paint() {
    var counts = { arrived: 0, wrong_end: 0, wrong_last_step: 0, void: 0 };
    document.querySelectorAll('.trip').forEach(function (el) {
      var v = state[el.dataset.key] || '';
      el.dataset.verdict = v;
      if (counts[v] !== undefined) counts[v] += 1;
      el.querySelectorAll('.verdict button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.v === v));
        b.disabled = !db;
      });
    });
    var judged = counts.arrived + counts.wrong_end + counts.wrong_last_step + counts.void;
    tallyEl.textContent = '已判 ' + judged + '/' + total + '　到了 ' + counts.arrived + '　终点错 ' + counts.wrong_end + '　最后一步错 ' + counts.wrong_last_step + '　不作数 ' + counts.void;
  }

  document.addEventListener('click', function (e) {
    var head = e.target.closest('.head');
    if (head) {
      var d = document.getElementById(head.getAttribute('aria-controls'));
      var open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      d.hidden = open;
      return;
    }
    var b = e.target.closest('.verdict button');
    if (!b || !db) return;
    var key = b.closest('.trip').dataset.key;
    var v = b.dataset.v;
    var ref = db.doc('verdicts/' + key);
    var clearing = state[key] === v;
    if (clearing) delete state[key]; else state[key] = v;
    paint();
    (clearing ? ref.delete() : ref.set({ verdict: v, at: new Date().toISOString() })).then(function () {
      say(clearing ? key + '：已清除判定' : key + '：已存「' + NAMES[v] + '」');
    }, function (err) {
      say(key + '：没存上（' + (err && err.code) + '），刷新页面后再判一次', true);
    });
  });

  paint();
  if (!window.claude || !window.claude.use) { say('这里存不了判定：页面没有连上数据库', true); return; }
  window.claude.use('db').then(function (handle) {
    if (!handle) { say('这里存不了判定：这个视图没有给页面数据库', true); return; }
    db = handle;
    say('判定会存进这张页的数据库');
    db.collection('verdicts').onSnapshot(function (snap) {
      var next = {};
      snap.docs.forEach(function (doc) { var x = doc.exists && doc.data(); if (x && NAMES[x.verdict]) next[doc.id] = x.verdict; });
      state = next;
      paint();
    }, function (err) {
      say('判定读不到了（' + (err && err.code) + '），刷新页面再试', true);
    });
    paint();
  });
})();
</script>
`;

fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`报告页：${path.relative(repo, path.join(out, 'index.html'))}`);
console.log(`到达（${scoreName}）${pct(a.rate)}，已判 ${a.judged}/${a.judged + a.pending}`);
console.log('files:', JSON.stringify(files));
