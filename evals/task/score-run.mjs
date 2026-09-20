/**
 * Scores a `live-github-run.mjs` log mechanically: parse and validation
 * failures, first-draw failures, ask share, hops, the intent mix and tokens.
 *
 * Two runs are only comparable through the same code. A baseline computed one
 * way and a candidate another turns every disagreement into an argument about
 * the instrument, so every run is scored by this file.
 *
 * `task_success_rate` is the programmatic Arrival check (`arrival.ts`: the final
 * URL and the last step on screen). The owner's verdict is the score; this is
 * only as good as its agreement with it.
 *
 * Run (needs the alias loader — it imports the product's own parser):
 *   node --experimental-strip-types --import ./evals/alias-loader-register.mjs \
 *     evals/task/score-run.mjs <log.ndjson> [more logs…] [--json]
 */
import fs from 'node:fs';
import { guideAgent } from '@/agent/agents/guide/agent';

/**
 * The harness writes one row per model call (`kind: 'call'`): the request's
 * parameters, the outcome as the panel sent it back, and that call's own
 * trace. One shape, read one way. The log used to keep calls in two shapes
 * read two ways, and reading only one of them is how "multi-step share" came
 * out 41% one afternoon and 50% the next — the first number was the replans
 * alone.
 */
function callsOf(rows) {
  return rows
    .filter((r) => r.kind === 'call')
    .map((r) => ({
      trip: `${r.pass}·${r.id}`,
      answered: r.outcome !== null && r.outcome !== undefined,
      ok: r.outcome?.ok !== false,
      error: r.outcome?.error,
      envelope: parse(r.outcome?.value, r.outcome?.tool),
      usage: r.outcome?.usage ?? null,
      entries: r.trace?.entries ?? [],
    }));
}

/**
 * The product's parser, not `JSON.parse`.
 *
 * `contract.ts` accepts JSON that a bare `JSON.parse` rejects — a fenced code
 * block, an envelope with prose around it. Those tolerance paths are the
 * product's real behaviour, and scoring with a stricter parser measures this
 * script instead. It cost one wrong number to find out: a run scored 4.5%
 * parse failures where the panel had accepted every single answer.
 */
const parse = (v, tool) => {
  if (typeof v !== 'string' || !v) return null;
  // Exactly the product's own branch: a tool call carries its intent in the
  // function name, so scoring it with the text parser reports every answer as
  // "缺少 intent" — an instrument failure that reads like a total product
  // failure. It already cost one run's numbers.
  const r = tool ? guideAgent.parseOutput(tool, v) : guideAgent.parseTextOutput(v);
  return r.kind === 'ok' ? r.envelope : null;
};

export function score(rows) {
  const calls = callsOf(rows);
  // Hops, not calls: how far the user was actually walked. Added after a run
  // scored better on every gate while covering half the ground — multi-step
  // share went up 12 points while total hops fell from 61 to 30, because the
  // plans got longer and the journeys stopped sooner. Four metrics that all
  // look at one call each cannot see that.
  const hops = rows.reduce((n, r) => n + (r.hops?.length ?? 0), 0);
  // Every journey that started, including the ones that never moved — leaving
  // those out turns "died at hop 0" into a perfect score.
  const attempted = rows.filter((r) => r.round !== undefined && r.pass !== undefined);
  const judged = attempted.filter((r) => typeof r.arrived === 'boolean');
  const arrived = judged.filter((r) => r.arrived).length;

  // First-draw failures, from each call's trace rather than its outcome: the
  // runner repairs internally, so a call that failed once and succeeded on the
  // re-draw leaves no trace in the result. That recovery is real and worth
  // having; it is also a second request, and this is the only place its cost
  // is visible.
  let firstDraw = 0;
  let firstDrawFailed = 0;
  for (const c of calls)
    for (const e of c.entries) {
      if (e.kind === 'request') firstDraw += 1;
      if (e.kind === 'repair') firstDrawFailed += 1;
    }

  let unanswered = 0;
  let parseFailures = 0;
  let validationFailures = 0;
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  const intents = {};
  const failureReasons = [];

  for (const c of calls) {
    // A request superseded before its answer came back — the page moved on —
    // said nothing. Counting it as a parse failure would blame the model.
    if (!c.answered) {
      unanswered += 1;
      continue;
    }
    if (c.usage) {
      prompt += c.usage.prompt ?? 0;
      completion += c.usage.completion ?? 0;
      cached += c.usage.cachedPrompt ?? 0;
    }
    if (!c.ok) {
      validationFailures += 1;
      failureReasons.push(String(c.error ?? '').slice(0, 80));
      continue;
    }
    if (!c.envelope) {
      parseFailures += 1;
      continue;
    }
    intents[c.envelope.intent] = (intents[c.envelope.intent] ?? 0) + 1;
  }

  const answered = calls.length - unanswered;
  const asks = intents.ask ?? 0;
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

  return {
    trips: attempted.length,
    calls: calls.length,
    /** Requests whose answer never came back — superseded before the panel
     *  replied. Counted here and left out of every rate below. */
    unanswered,
    answered,
    parse_failure_rate: rate(parseFailures, answered),
    parse_failures: parseFailures,
    validation_failures: validationFailures,
    failure_reasons: failureReasons,
    /** The programmatic Arrival check — not the owner's verdict. */
    task_success_rate: rate(arrived, judged.length),
    arrived,
    judged: judged.length,
    /** How often the first draw was unusable, before the repair round. */
    first_draw_failure_rate: rate(firstDrawFailed, firstDraw),
    first_draw_failures: firstDrawFailed,
    first_draws: firstDraw,
    /** A rate, not a count: runs differ in how many calls they make, and
     *  comparing counts across them is arithmetic that does not hold. */
    validation_failure_rate: rate(validationFailures, answered),
    /** An ask stops the journey and hands it back to the user. Cheap to
     *  produce, and it is not a cheaper right answer. */
    ask_share: rate(asks, answered - parseFailures - validationFailures),
    asks,
    hops,
    hops_per_trip: attempted.length ? Math.round((hops / attempted.length) * 10) / 10 : 0,
    intents,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    tokens_per_call: answered ? Math.round((prompt + completion) / answered) : 0,
    cached_prompt_tokens: cached,
    /** What was actually charged at full rate. `tokens_per_call` counts cached
     *  tokens as if they were not, so once caching hits the two diverge — this
     *  is the one that tracks the bill. Equal to `tokens_per_call` on an
     *  endpoint that reports no cache figure, which is the honest fallback. */
    billable_per_call: answered ? Math.round((prompt - cached + completion) / answered) : 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const logs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!logs.length) {
    console.error(
      '用法: node --experimental-strip-types --import ./evals/alias-loader-register.mjs evals/task/score-run.mjs <log.ndjson> [更多日志…] [--json]',
    );
    process.exit(1);
  }
  // Several logs pool into one score: a run whose passes went to separate
  // files is still one run.
  const rows = logs.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  if (logs.length > 1 && !process.argv.includes('--json')) console.log(`合并 ${logs.length} 份日志\n`);
  const s = score(rows);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`趟数 ${s.trips}   模型调用 ${s.calls}${s.unanswered ? `（其中 ${s.unanswered} 次没等到结果，不计入下面的比率）` : ''}`);
    console.log(`  解析失败率        ${s.parse_failure_rate}%  (${s.parse_failures}/${s.answered})`);
    console.log(`  校验失败率        ${s.validation_failure_rate}%  (${s.validation_failures}/${s.answered})  ${JSON.stringify(s.failure_reasons)}`);
    console.log(`  ★ 到达率（程序化判据） ${s.task_success_rate}%  (${s.arrived}/${s.judged})`);
    console.log(`  首抽失败率        ${s.first_draw_failure_rate}%  (${s.first_draw_failures}/${s.first_draws}，各多花一次调用)`);
    console.log(`  停下来问的占比    ${s.ask_share}%  (${s.asks} 次 ask)`);
    console.log(`  实际走了几跳      ${s.hops}  (${s.hops_per_trip}/趟)`);
    console.log(`  intent 分布       ${JSON.stringify(s.intents)}`);
    console.log(`  token            ${s.total_tokens}  (prompt ${s.prompt_tokens} / completion ${s.completion_tokens}，均次 ${s.tokens_per_call})`);
    console.log(`  其中缓存命中      ${s.cached_prompt_tokens}  → 实际计费均次 ${s.billable_per_call}`);
  }
}
