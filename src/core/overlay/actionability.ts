import type { Probe } from './dom';

/**
 * CONTEXT.md `Actionability`: whether the element a step points at can be
 * operated right now, by Playwright's mechanical definition — visible,
 * enabled, the hit test lands on it, and the same bounding box on two
 * consecutive animation frames.
 *
 * Judged once, over those two frames, and never again for the same step: a
 * target that cannot be operated right now is a fact to hand the model, not a
 * reason to look again. Whether to wait for it is the model's to say
 * (`wait_for`), because only the model knows what it is waiting for.
 */

/** Why the target cannot be operated right now. */
export type NotActionable = 'hidden' | 'disabled' | 'covered' | 'moving';

/** Playwright's "stable": the same bounding box on this many consecutive frames. */
export const STABLE_FRAMES = 2;

/** One frame's look at the target. */
export interface FrameLook {
  probe: Probe;
  /** Something else would receive a click at the target's centre. */
  covered: boolean;
}

/**
 * The verdict over consecutive looks, one per frame. Visibility, enablement
 * and the hit test are read off the last look; stability compares each look
 * with the one before it.
 */
export function judge(looks: readonly FrameLook[]): NotActionable | null {
  const last = looks.at(-1);
  if (!last || !last.probe.visible) return 'hidden';
  if (!last.probe.enabled) return 'disabled';
  if (last.covered) return 'covered';
  for (let i = 1; i < looks.length; i++) {
    const [a, b] = [looks[i - 1]!.probe.rect, looks[i]!.probe.rect];
    if (a.some((v, k) => v !== b[k])) return 'moving';
  }
  return null;
}

/**
 * Looks at the target on each of the next `STABLE_FRAMES` animation frames,
 * then hands the verdict to `done`. The returned function calls it off; a
 * check called off says nothing.
 */
export function checkActionability(
  look: () => FrameLook,
  nextFrame: (fn: () => void) => () => void,
  done: (why: NotActionable | null) => void,
): () => void {
  const looks: FrameLook[] = [];
  let cancel = nextFrame(function tick() {
    looks.push(look());
    if (looks.length < STABLE_FRAMES) {
      cancel = nextFrame(tick);
      return;
    }
    done(judge(looks));
  });
  return () => cancel();
}
