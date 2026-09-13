import type { RunEvent } from './runner';
import { moduleOf, type GuideAgentEnvelope } from './registry';
import type { Trace, TraceEntry } from '@/shared/types';

/**
 * What a run actually sent and got back, kept where a person can read it.
 *
 * `runner.ts` yields the events; this file is the half that survives the run.
 * The split matters: a caller that wants the events live already has them from
 * the generator, so nothing here is on the path of any decision. Turn the
 * whole file off and the product behaves identically — the property
 * `runner.spec.ts`'s "事件流是装饰，不承重" pins down, and this file must not
 * be what breaks it.
 *
 * Off by default. A trace holds the entire element table twice per call (once
 * in the prompt, once in the answer), so leaving it on would put every page
 * the user visits into extension storage for nobody's benefit. The switch is
 * a stored value rather than a build flag precisely so a Playwright run can
 * turn it on against a production build — the builds where the interesting
 * failures happen are exactly the ones a compile-time flag cannot reach.
 *
 * **Who writes it.** The run happens in the side panel (CONTEXT.md `Panel`), but N-6
 * forbids the panel from touching `storage.session` at all: the service
 * worker is the single writer of anything keyed by thread (CONTEXT.md `Host`). So the
 * panel only *collects* — `createTrace` — and sends what it collected back on
 * the result message it was already sending anyway; the worker merges and
 * stores it (`mergeTrace`). The switch itself lives in `storage.local`, the
 * one area the panel does read, so a disabled trace costs one storage read
 * and puts nothing on the wire.
 *
 * N-1: no `chrome.*` here. Storage arrives as a port, the way
 * `agent/thread/ports.ts` does it, so this runs in a plain node test.
 */

/** In `storage.session`, written by the worker only. */
export const traceKey = (threadId: string): string => `trace:${threadId}`;

/**
 * How much of one thread's history is kept. Each entry can carry a whole
 * serialized element table, so this is a size ceiling as much as a count: 24
 * covers the longest journey observed live (6 hops, ~10 calls) with room over,
 * and drops the oldest rather than refusing to write.
 */
export const TRACE_MAX_ENTRIES = 24;

/**
 * Accumulates one run's events. Runs unconditionally — the pushes are free,
 * and doing them without first consulting the switch means a trace turned on
 * *during* a call still captures that call rather than the one after it.
 */
export function createTrace(now: () => number = Date.now) {
  const entries: TraceEntry[] = [];
  let system = '';

  return {
    record(e: RunEvent): void {
      switch (e.kind) {
        case 'request':
          system = e.system;
          entries.push({ at: now(), kind: 'request', user: e.user });
          return;
        case 'repair':
          entries.push({ at: now(), kind: 'repair', system: e.system, user: e.user });
          return;
        case 'raw':
          entries.push({ at: now(), kind: 'raw', text: e.text });
          return;
        case 'parse_error':
          entries.push({ at: now(), kind: 'parse_error', message: e.message });
          return;
        case 'settled': {
          // The intent only. The envelope it came from is the immediately
          // preceding `raw` entry, verbatim — storing it again would double
          // the trace to say the same thing twice.
          entries.push({ at: now(), kind: 'settled', intent: e.envelope.intent });
          const blocked = rationales(e.envelope).find(saysTableIsMissingIt);
          if (blocked) entries.push({ at: now(), kind: 'not_in_table', said: blocked });
          return;
        }
        case 'violation':
          entries.push({ at: now(), kind: 'violation', reason: e.reason });
          return;
      }
    },
    /** `null` when the run produced nothing worth sending, so the caller has
     *  one thing to test rather than a length check of its own. */
    snapshot(): Trace | null {
      return entries.length ? { system, entries: [...entries] } : null;
    },
  };
}

export type TraceRecorder = ReturnType<typeof createTrace>;

/**
 * Every free-text rationale an envelope carries.
 *
 * The answering intent's module says which of its fields are rationales.
 * Probing for fields (`'why' in envelope`) would read the same today and go
 * quiet the day an intent arrives with a differently-named rationale; a module
 * that forgets to say does not compile.
 */
function rationales(envelope: GuideAgentEnvelope): readonly string[] {
  return moduleOf(envelope).rationales(envelope);
}

/**
 * Does the model say, in its own words, that what it needs is not in the table?
 *
 * There is no field for this and deliberately no new one: giving `guide` an
 * "it isn't listed" exit would be dead code the moment the table stops
 * dropping things, and this exists precisely to find out whether it has. So it
 * reads the rationale the model already writes.
 *
 * A phrase probe, and calibrated as one. Against 86 rationales from a live run
 * it fires 12 times, and all twelve read as the real thing — 「本页元素表中没有
 * 直接可见的 Actions 链接」, 「这些标签不在当前元素表列出范围内」, 「页面已截断，
 * 未列出 Releases」. Requiring a negation *near* the mention is what makes it
 * usable: matching 「表里」 alone also caught 「建议列表中选择」 and 「结果列表里
 * 第一个正是目标仓库」, which are the model reading the table successfully.
 *
 * 12/86 is the baseline this is meant to drive to zero. It is diagnosis, never
 * a branch — nothing downstream reads it.
 *
 * **It only speaks Chinese.** The product guides any site in any language, so
 * zero hits on an English or Malay journey means the probe was not looking, not
 * that the table was complete. Read a zero only alongside the language the run
 * was conducted in.
 */
export function saysTableIsMissingIt(why: string): boolean {
  const TABLE = '(?:元素表|表里|表中|表内|列出)';
  const MISSING = '(?:没有|没列|未列|不在|看不到|被截断|已裁剪|裁剪了|截断)';
  const near = '[^。；\n]{0,26}';
  return new RegExp(`${TABLE}${near}${MISSING}|${MISSING}${near}${TABLE}`).test(why);
}

const isTrace = (v: unknown): v is Trace =>
  typeof v === 'object' && v !== null && Array.isArray((v as Trace).entries);

/**
 * Appends a run to whatever this thread already had. Pure — the worker does
 * the reading and writing around it.
 *
 * `existing` is `unknown` on purpose: it comes back off `storage.session`,
 * which can hold anything a previous version of this code wrote, and the
 * honest response to a shape that is no longer recognisable is to start over
 * rather than to crash the message handler that was storing it.
 */
export function mergeTrace(existing: unknown, incoming: Trace, max: number = TRACE_MAX_ENTRIES): Trace {
  const prior = isTrace(existing) ? existing.entries : [];
  return { system: incoming.system, entries: [...prior, ...incoming.entries].slice(-max) };
}
