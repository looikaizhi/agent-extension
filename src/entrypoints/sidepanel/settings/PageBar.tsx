import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';

/**
 * The top of a settings page: the way back, where this page sits, and one
 * thing said about it on the right (`aside`).
 */
export function PageBar({
  title,
  parent,
  backLabel,
  onBack,
  aside,
}: {
  title: string;
  /** The page above this one, said small over the title. */
  parent: string;
  /** What going back returns to — the back button's accessible name. */
  backLabel: string;
  onBack: () => void;
  aside?: ReactNode;
}) {
  return (
    <div className="page-bar">
      <button className="back" aria-label={backLabel} onClick={onBack}>
        <Icon name="back" size={15} />
      </button>
      <div className="page-bar-id">
        <div className="crumb">{parent}</div>
        <h1>{title}</h1>
      </div>
      {aside}
    </div>
  );
}
