import type { statusOf } from '../view-model';

type Status = NonNullable<ReturnType<typeof statusOf>>;

/**
 * Which page the panel is about, and what the guide is doing on it. Chrome's
 * own panel header already says 页面引导, so this space goes to the page.
 *
 * The mark is the host's first letter rather than the site's favicon: the
 * favicon is a request to the site made on the panel's behalf, and a letter
 * says which site this is just as well.
 */
export function PageHeader({ title, url, status }: { title: string; url: string; status: Status | null }) {
  const host = hostOf(url);
  return (
    <header className="page-header">
      <span className="page-mark" aria-hidden="true">
        {(host[0] ?? '·').toUpperCase()}
      </span>
      <div className="page-id">
        <div className="page-title">{title || host || '（无活动标签页）'}</div>
        {url && (
          <div className="url" title={url}>
            {url.replace(/^https?:\/\//, '')}
          </div>
        )}
      </div>
      {status && (
        <span className={`status ${status.tone}`}>
          <span className="dot" />
          {status.text}
        </span>
      )}
    </header>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
