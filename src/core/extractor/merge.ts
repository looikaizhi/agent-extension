import type { FrameNote, PromptTable, TableSource } from './types';

/**
 * One table out of the several a page with embedded frames produces.
 *
 * Each document is read by its own content script and projects its own table;
 * the host is the only place that can see all of them, so this is where they
 * become the single thing the model is shown. Nothing here re-projects or
 * re-prunes: every frame already applied its own budget, and a second pass at
 * this level would have to re-derive `path`, `nth` and ambiguity across
 * documents that never shared a DOM.
 *
 * **Refs do not collide**, and that is not luck: `makeRef(frameId, n)` writes
 * `e12` in the top document and `f3e12` in frame 3, so concatenating is safe
 * and the frame a ref belongs to can always be read back out of it.
 *
 * The table's own identity — `snapshotId`, `url`, `title`, `structureHash` —
 * stays the top document's. Those answer "which page is this", and a page with
 * three frames in it is still one page; what each *document* was when it was
 * read is recorded in `sources`, which is what a command is routed by.
 */
export function mergeTables(
  top: PromptTable,
  framed: readonly { frameId: number; url: string; table: PromptTable }[],
): PromptTable {
  if (framed.length === 0) return top;

  const sources: TableSource[] = [
    { frameId: 0, snapshotId: top.snapshotId, url: top.url },
    ...framed.map((f) => ({ frameId: f.frameId, snapshotId: f.table.snapshotId, url: f.url })),
  ];

  return {
    ...top,
    items: [...top.items, ...framed.flatMap((f) => f.table.items)],
    // Every document's tail cut adds up: the model is told one number and it
    // has to mean "how much of this page you are not seeing".
    omitted: top.omitted + framed.reduce((n, f) => n + f.table.omitted, 0),
    // One watchdog firing anywhere makes the whole table partial.
    degraded: top.degraded || framed.some((f) => f.table.degraded),
    // Measurement only, never sent to a model (`PromptTable.ambiguity`).
    // Weighted by how many items each document contributed, so a two-item
    // frame cannot swing the figure for a 300-item page.
    ambiguity: weighted([top, ...framed.map((f) => f.table)]),
    frames: holesLeft(top.frames, framed),
    sources,
  };
}

/** Which frame a ref belongs to — the inverse of `makeRef`. `e12` is the top
 *  document; `f3e12` is frame 3. */
export function frameOf(ref: string): number {
  const m = /^f(\d+)e\d+$/.exec(ref);
  return m ? Number(m[1]) : 0;
}

/** The document a ref must be painted in, as the table recorded it. `null`
 *  when this table never entered that frame — the caller has nothing safe to
 *  send, and guessing the top document would paint one page's ref against
 *  another's snapshot. */
export function sourceFor(table: PromptTable, ref: string): TableSource | null {
  const frameId = frameOf(ref);
  if (!table.sources) return frameId === 0 ? { frameId: 0, snapshotId: table.snapshotId, url: table.url } : null;
  return table.sources.find((s) => s.frameId === frameId) ?? null;
}

const weighted = (tables: readonly PromptTable[]): number => {
  const n = tables.reduce((sum, t) => sum + t.items.length, 0);
  return n === 0 ? 0 : tables.reduce((sum, t) => sum + t.ambiguity * t.items.length, 0) / n;
};

/**
 * The frames still unread after this merge.
 *
 * A note says "there is something here I cannot see into", and once a frame
 * has been read that sentence is false — leaving it in would tell the model a
 * hole exists where its controls are now listed. But a `FrameNote` carries no
 * frame id (it is written by the top document, which cannot know one), so the
 * only thing the two sides share is the host. Matched by count per host: three
 * notes from `js.stripe.com` with two of that host entered leaves one note.
 *
 * Erring toward keeping a note is deliberate. An extra hole reported costs the
 * model one sentence; a hole *not* reported is the whole defect this feature
 * exists to fix — "not in the table" read as "not on the page".
 */
function holesLeft(
  notes: readonly FrameNote[] | undefined,
  framed: readonly { url: string }[],
): readonly FrameNote[] | undefined {
  if (!notes?.length) return notes;
  const entered = new Map<string, number>();
  for (const f of framed) {
    const host = hostOf(f.url);
    entered.set(host, (entered.get(host) ?? 0) + 1);
  }
  return notes.filter((note) => {
    const left = entered.get(note.host);
    if (!left) return true;
    entered.set(note.host, left - 1);
    return false;
  });
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};
