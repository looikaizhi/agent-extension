/**
 * Arrival, checked by a program (CONTEXT.md `Arrival`): the journey stopped at
 * an acceptable address, *and* what was on screen when it stopped was an
 * acceptable last step. Both halves — a right address with the wrong control
 * highlighted is not there, because a user told "click this" clicks it.
 *
 * The owner's verdict is the score. This check exists so that every run has a
 * number before anyone has judged it, and it is trusted only as far as
 * `agreement` below says it agrees with the owner.
 */

/** What was on screen when the journey stopped. */
export type LastStep =
  /** The model said it had arrived; nothing is highlighted. `after` is the
   *  title of the step the user walked just before, when there was one. */
  | { kind: 'done'; after?: string }
  /** A step still highlighted — or loaded behind the cross-site card, which
   *  shows it the moment the user confirms. */
  | { kind: 'step'; role: string; name: string; action: string; behindCrossSiteCard?: boolean }
  /** Ended some other way, with nothing on screen (going in circles, a quota). */
  | { kind: 'none'; why: string };

/**
 * A last step that counts: a control by role and name, or the model's `done` —
 * which for an acting goal counts only `after` a step that takes effect, since
 * seeing the thing is not having done it (CONTEXT.md `Acting goal`).
 */
export type LastStepPattern = { done: true; after?: RegExp } | { role: string; name: RegExp };

/**
 * One way of being there: an address, and what may be on screen at it.
 *
 * Pairs rather than one list of addresses and one of last steps: for "take me
 * to the docs site", `done` counts on the docs site and a highlighted link to
 * it counts on the docs repository — but `done` on the repository does not,
 * and two independent lists would accept it.
 */
export interface Acceptable {
  /** Matched against the whole final URL. Never with the `g` flag: a global
   *  RegExp's `test` remembers where it stopped last time. */
  url: RegExp;
  lastSteps: readonly LastStepPattern[];
}

export interface Verdict {
  arrived: boolean;
  /** Which half failed: no acceptable address, or an acceptable address
   *  without one of its acceptable last steps. `null` when arrived. */
  missed: 'url' | 'last_step' | null;
}

const fits = (last: LastStep, p: LastStepPattern): boolean => {
  if ('done' in p) return last.kind === 'done' && (!p.after || (last.after !== undefined && p.after.test(last.after)));
  return last.kind === 'step' && last.role === p.role && p.name.test(last.name);
};

export function judge(endUrl: string, last: LastStep, accept: readonly Acceptable[]): Verdict {
  const here = accept.filter((a) => a.url.test(endUrl));
  if (!here.length) return { arrived: false, missed: 'url' };
  return here.some((a) => a.lastSteps.some((p) => fits(last, p)))
    ? { arrived: true, missed: null }
    : { arrived: false, missed: 'last_step' };
}

/**
 * The owner's verdict on one journey. `void` is 不作数: a captcha, a site that
 * was down — nothing the product did — so the journey counts for neither side.
 */
export type HumanVerdict = 'arrived' | 'wrong_end' | 'wrong_last_step' | 'void';

export interface Agreement {
  /** Journeys with a verdict that counts. */
  judged: number;
  void: number;
  /** Arrived by both / by the program only / by the owner only / by neither. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** `null` whenever the denominator is 0: "not measured" is not 0%. */
  agreement: number | null;
  /** Of the journeys the program called arrived, the share the owner did too —
   *  how far a programmatic "arrived" can be believed. */
  precision: number | null;
  /** Of the journeys the owner called arrived, the share the program caught. */
  recall: number | null;
}

/** How well the programmatic check agrees with the owner, the owner being right. */
export function agreement(pairs: readonly { programmatic: boolean; human: HumanVerdict }[]): Agreement {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let voided = 0;
  for (const { programmatic, human } of pairs) {
    if (human === 'void') {
      voided += 1;
      continue;
    }
    const owner = human === 'arrived';
    if (programmatic && owner) tp += 1;
    else if (programmatic) fp += 1;
    else if (owner) fn += 1;
    else tn += 1;
  }
  const share = (a: number, b: number) => (b ? a / b : null);
  const judged = tp + fp + fn + tn;
  return {
    judged,
    void: voided,
    tp,
    fp,
    fn,
    tn,
    agreement: share(tp + tn, judged),
    precision: share(tp, tp + fp),
    recall: share(tp, tp + fn),
  };
}
