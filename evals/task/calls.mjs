// Shared by the Task eval and the Decision eval's recorder: both write the
// same `kind: 'call'` rows, because the Decision eval's corpus reads exactly
// one row shape (`evals/decision/corpus.ts`).
/**
 * Every model call a journey made, one log row each: the request's parameters
 * whole (the full element table among them), the outcome whole, and the
 * call's own trace.
 *
 * The trace comes from the result message itself — the panel sends each
 * call's trace back beside its result — so it pairs with its request by
 * `effectId` and is never cut short by the thread trace's 24-entry cap, which
 * a five-hop journey already fills.
 *
 * Every call, not the first of each hop: a page that arrives in two stages
 * re-plans twice, and a log that kept one call per hop lost a run's middle
 * reasoning. And whole, not field by field: a hand-written projection dropped
 * `tool`, `expect_after` and `previous_step` in turn as the envelope grew, and
 * each read downstream as the model having failed to produce it.
 *
 * `hop` is the hop whose window the request went out in; 0 is the opening plan.
 */
export function callsOf(w, marks, row) {
  const results = new Map(w.filter((m) => m?.type === 'EFFECT_RESULT').map((m) => [m.effectId, m]));
  const seen = new Set();
  const out = [];
  w.forEach((m, i) => {
    if (m?.type !== 'EFFECT_REQUEST' || m.kind !== 'callModel' || seen.has(m.effectId)) return;
    seen.add(m.effectId);
    const result = results.get(m.effectId);
    out.push({
      kind: 'call',
      pass: row.pass,
      id: row.id,
      seq: out.length + 1,
      hop: marks.filter((k) => k.from <= i).at(-1)?.hop ?? 0,
      effectId: m.effectId,
      params: m.params,
      outcome: result?.outcome ?? null,
      trace: result?.trace ?? null,
    });
  });
  return out;
}
