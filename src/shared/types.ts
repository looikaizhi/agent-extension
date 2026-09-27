/** Frame-qualified element handle. `e{n}` for the top frame, `f{frameId}e{n}` otherwise.
 *  Valid only within one snapshot (CONTEXT.md `Ref`). */
export type Ref = string & { readonly __brand: 'Ref' };

/** Refuses to compile unless `T` is `never` — how the compile-time checks fail. */
export type Never<T extends never> = T;

export const makeRef = (frameId: number, n: number): Ref =>
  (frameId === 0 ? `e${n}` : `f${frameId}e${n}`) as Ref;

/** Bounding box in the *owning frame's* viewport coordinates, rounded. */
export type Rect = readonly [x: number, y: number, w: number, h: number];

export type UIState =
  | 'disabled'
  | 'readonly'
  | 'required'
  | 'invalid'
  | 'checked'
  | 'mixed'
  | 'selected'
  | 'expanded'
  | 'collapsed'
  | 'current'
  | 'busy';

export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label'
  | 'content'
  | 'placeholder'
  | 'title'
  | 'alt'
  | 'value'
  | 'testid'
  | 'href'
  | 'none';

/** One coarse waypoint in a `point`'s `route`. No `ref`, no control
 *  name — see design doc §1.3/§5.4 and `TOOL_CHOICE_CLOSING`: `route`
 *  is allowed to be invented, so its shape carries nothing a `Ref` could be. */
export interface GuideRouteHop {
  at: string;
  goal: string;
}

/** The optional arrival check on a `point`. `must_contain` is optional
 *  *within* an optional field — the model may give `via_ref` without a shape
 *  expectation, or omit `expect_after` entirely (§5.4: "宁可不给，也不要瞎编"). */
export interface GuideExpectAfter {
  via_ref: Ref;
  must_contain?: { role: string; name?: string };
}

/** What an `ask` wants back from the user: one of its options, or words only
 *  they have. Here for the same reason as the two types above — the Thread and
 *  the wire message carry it. */
export type AskWants = 'choice' | 'text';

/** What a `wait_for` waits for its text to do on the page. Here because the
 *  content-script verb, the Thread and the wire all carry it. */
export type WaitUntil = 'appears' | 'gone';

/** One candidate an `ask` lists for the user to choose from. */
export interface AskOption {
  ref: Ref;
  label: string;
}

/* What a guide run sent and got back, as the panel hands it to the worker —
 * recorded by `agent/agents/guide/trace.ts`. Kept here for the same reason as
 * the two types above: a wire message carries it, and the wire must not need
 * the guide agent to say so. */

export type TraceEntry =
  | { at: number; kind: 'request'; user: string }
  | { at: number; kind: 'raw'; text: string }
  | { at: number; kind: 'parse_error'; message: string }
  | { at: number; kind: 'repair'; system: string; user: string }
  | { at: number; kind: 'settled'; intent: string }
  /** Diagnosis only, never acted on: the model said, in its own rationale, that
   *  what it needs is not in the element table. See `saysTableIsMissingIt`. */
  | { at: number; kind: 'not_in_table'; said: string }
  | { at: number; kind: 'violation'; reason: string };

export interface Trace {
  /**
   * The guide's system message, stored once for the whole thread rather than
   * on every entry: it is ~8KB and byte-identical on every call, so repeating
   * it 24 times would make the trace mostly one string. A `repair` entry
   * carries its own `system` inline because that one genuinely differs — a
   * fresh minimal conversation that never sees the page (§5.9).
   *
   * **Rendered text, and it stays rendered text** even as the messages the
   * agent builds become structured (content parts, a neutral tool spec). A
   * trace is read by two audiences and neither of them is a protocol: a person
   * opening the debug panel, and the Decision corpus, which uses exactly this
   * string to prove that a recorded state replays as the same call. Let it
   * follow the neutral types into objects and every committed state's `sent`
   * stops matching — and it fails *green*, because the extractor filters out
   * anything that differs and would simply produce nothing.
   */
  system: string;
  /**
   * The tool schema the request offered, rendered as JSON — stored once, like
   * `system`, and for the same reason. What the model could answer with is
   * half of what it was asked; replaying a call without it is guessing.
   * Rendered text for the same reason as `system` above.
   */
  tools: string;
  entries: TraceEntry[];
}

/**
 * §5.7's three orthogonal axes as they cross the wire — never merged into one
 * "confidence" number: 合并任意两轴都会造出一个既不能解释也不能复核的等级.
 * `Binding` is this paint's own verdict, `Evidence` what the step rests on,
 * `Check` whether arrival was judged.
 */
export type WireBinding = 'bound' | 'ambiguous' | 'unbound';
export type WireEvidence = 'documented' | 'model';
export type WireCheck = 'pass' | 'unknown' | 'skipped';
