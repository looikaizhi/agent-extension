import type { WaitUntil } from '@/shared/types';

/**
 * The content script's half of `wait_for`: watch the page's visible text until
 * a piece of it appears (or goes), and answer the moment it does — or when the
 * time the model allowed runs out.
 *
 * Driven by the page's own changes, never by polling on a clock: an interval
 * would be one more guess about how long to wait between looks, and a change
 * could land between two of them unseen. What the page does is read at most
 * once per frame, because a page that is busy fires mutations by the hundred.
 *
 * Everything that touches the page comes in through `WaitPorts`, so the policy
 * — when to look, when to stop, what counts — is pinned in node with a fake
 * page and a fake clock (`tests/unit/wait-for.spec.ts`). `domWaitPorts` below
 * is the real page, and only e2e exercises it.
 */

export interface WaitPorts {
  /** The page's visible text right now. */
  readText(): string;
  /** Calls `onChange` whenever the page changes; returns a stop. */
  observe(onChange: () => void): () => void;
  /** Runs `cb` at the next frame. */
  frame(cb: () => void): void;
  /** Runs `cb` after `ms`; returns a cancel. */
  after(ms: number, cb: () => void): () => void;
  now(): number;
}

export interface WaitOutcome {
  met: boolean;
  waitedMs: number;
}

/** Whitespace is how text is laid out, not what it says: a line break between
 *  two words on the page reads as the space the model wrote between them. */
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export function waitForText(ports: WaitPorts, until: WaitUntil, text: string, timeoutMs: number): Promise<WaitOutcome> {
  const wanted = normalize(text);
  const holds = () => {
    const present = normalize(ports.readText()).includes(wanted);
    return until === 'appears' ? present : !present;
  };
  const start = ports.now();
  if (holds()) return Promise.resolve({ met: true, waitedMs: 0 });

  return new Promise((resolve) => {
    let settled = false;
    let scheduled = false;
    let stop = () => {};
    let cancel = () => {};
    const finish = (met: boolean) => {
      if (settled) return;
      settled = true;
      stop();
      cancel();
      resolve({ met, waitedMs: Math.round(ports.now() - start) });
    };
    stop = ports.observe(() => {
      if (scheduled || settled) return;
      scheduled = true;
      ports.frame(() => {
        scheduled = false;
        if (!settled && holds()) finish(true);
      });
    });
    // One last look when the time is up: a frame that never came — a tab in the
    // background runs none — must not turn a change that did happen into "not seen".
    cancel = ports.after(timeoutMs, () => finish(holds()));
  });
}

/** The real page. */
export const domWaitPorts: WaitPorts = {
  readText: () => document.body?.innerText ?? '',
  observe: (onChange) => {
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => mo.disconnect();
  },
  frame: (cb) => void requestAnimationFrame(() => cb()),
  after: (ms, cb) => {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  },
  now: () => performance.now(),
};
