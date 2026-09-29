import { Fragment } from 'react';
import { progressCells, stepLabels } from '@/shared/progress';
import { Icon } from '../ui/Icon';

/**
 * Where this step sits in the run, drawn the two ways the styles want it — a
 * segmented bar for 夜航, a stepper for 景深 — from the same cells. Both are
 * rendered and the style shows one (`.for-hud` / `.for-depth`), so nothing here
 * needs to know which style is on.
 *
 * A model-planned run never knows how many steps are left, so its track ends
 * open (`more`) instead of counting down to a total it does not have.
 */
export function Progress({ index, total }: { index: number; total: number | null }) {
  const cells = progressCells(index, total);
  const label = stepLabels(index, total);
  return (
    <div className="progress">
      <div className="for-hud progress-hud">
        <span className="step-n">{label.hud}</span>
        <span className="bar" aria-hidden="true">
          {cells.map((c, i) => (
            <span key={i} className={`seg ${c}`} />
          ))}
        </span>
      </div>
      <div className="for-depth progress-depth">
        <span className="stepper" aria-hidden="true">
          {cells.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className={`s-link ${c === 'cur' ? 'done' : c}`} />}
              {c !== 'more' && (
                <span className={`s-node ${c}`}>
                  {c === 'done' && <Icon name="check" size={11} />}
                  {c === 'cur' && <span className="pip" />}
                </span>
              )}
            </Fragment>
          ))}
        </span>
        <span className="step-n">{label.depth}</span>
      </div>
    </div>
  );
}
