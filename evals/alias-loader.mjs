/**
 * Maps `@/` to `src/`, and follows the extensionless relative imports that TS
 * source is written with. Bundlers and vitest both do this; node's resolver
 * does neither, so any plain `node` script that imports product code needs it.
 *
 * Lives in `evals/` because the evals depend on it — `npm run eval` takes the
 * node budget from the product through it instead of keeping a second copy —
 * and `evals/` is versioned while `tests/` is not, so nothing an eval needs can
 * live under `tests/`. The throwaway probes in `tests/spike/` borrow it from
 * here. It also used to resolve
 * `src/` from a hard-coded absolute path, which made every consumer runnable on
 * exactly one machine — the path is derived from this file's own location now.
 */
const ROOT = new URL('../src/', import.meta.url).href;

/**
 * A bare directory means that directory's `index.ts`. Missing that case cost a
 * whole live run once: the harness imports `machine.ts`, which then reached a
 * directory import (`./demo`, since moved into `agent/skills/`); the run died on the first line
 * and the log kept the *previous* run's contents, so the scores read as a clean
 * repeat of the run before.
 */
function candidates(spec) {
  if (/\.[a-z]+$/.test(spec)) return [spec];
  return [`${spec}.ts`, `${spec}/index.ts`];
}

export async function resolve(specifier, context, next) {
  const base = specifier.startsWith('@/') ? new URL(specifier.slice(2), ROOT).href : specifier;
  if (!specifier.startsWith('@/') && !specifier.startsWith('./') && !specifier.startsWith('../'))
    return next(specifier, context);

  let lastErr;
  for (const c of candidates(base)) {
    try {
      return await next(c, context);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
