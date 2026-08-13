import type { Ref } from '@/shared/types';

/**
 * ref → live element, scoped to one snapshot generation.
 *
 * The generation check is R-04's *local* line of defence: the content script is
 * the only process that knows whether a snapshot is still valid, so it refuses
 * stale handles without consulting anyone.
 */
class RefRegistry {
  private gen = '';
  private map = new Map<Ref, WeakRef<Element>>();
  private staging = new Map<Ref, WeakRef<Element>>();

  stage(ref: Ref, el: Element): void {
    this.staging.set(ref, new WeakRef(el));
  }

  commit(snapshotId: string): void {
    this.gen = snapshotId;
    this.map = this.staging;
    this.staging = new Map();
  }

  get generation(): string {
    return this.gen;
  }

  /** null when the snapshot is stale, the ref is unknown, or the node is gone. */
  resolve(snapshotId: string, ref: Ref): Element | null {
    if (snapshotId !== this.gen) return null;
    const el = this.map.get(ref)?.deref() ?? null;
    return el?.isConnected ? el : null;
  }
}

export const registry = new RefRegistry();
