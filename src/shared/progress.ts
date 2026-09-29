/**
 * Which step of a run this is, said the two ways the looks say it — shared by
 * the side panel and the overlay on the page, so the two never count
 * differently.
 */

/**
 * The step's label in each style: 夜航 counts like an instrument
 * (「STEP 02」), 景深 says it (「第 2 步」). The side panel renders both and
 * lets the style show one; the overlay on the page does the same.
 *
 * `total` is `null` for a model-planned run, which never knows how many steps
 * are left — so it says which step this is and nothing about the end.
 */
export function stepLabels(index: number, total: number | null): { hud: string; depth: string } {
  const n = index + 1;
  const pad = (x: number) => String(x).padStart(2, '0');
  return total === null
    ? { hud: `STEP ${pad(n)}`, depth: `第 ${n} 步` }
    : { hud: `STEP ${pad(n)} / ${pad(total)}`, depth: `第 ${n} 步，共 ${total} 步` };
}

/**
 * The progress track, cell by cell: steps done, this one, and what is left —
 * counted when the plan knows (`todo`), an open end when it does not (`more`).
 * Only the last `keep` steps done are drawn, so a long run does not shrink
 * every cell to a sliver.
 */
export type ProgressCell = 'done' | 'cur' | 'todo' | 'more';

export function progressCells(index: number, total: number | null, keep = 4): ProgressCell[] {
  const done = Array<ProgressCell>(Math.min(index, keep)).fill('done');
  const after: ProgressCell[] = total === null ? ['more'] : Array<ProgressCell>(Math.max(0, total - index - 1)).fill('todo');
  return [...done, 'cur', ...after];
}
