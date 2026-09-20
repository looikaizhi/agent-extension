/**
 * CONTEXT.md's `View`: whether two addresses are the same page — the whole
 * address minus its fragment, and nothing about what is on the page.
 *
 * The address is the one identity a page declares for itself, so nothing here
 * has to guess. The fragment is dropped because a documentation site rewrites
 * it as the reader scrolls, and scrolling is not going anywhere. Both sides are
 * redacted first: an element table carries its address redacted while the tab
 * reports it raw, and on any page with a `session=` parameter the two would
 * otherwise never agree.
 *
 * The one definition every judgement of it reads. Before it, "which page is
 * this" was answered five ways — origin + pathname, the same plus the first
 * landmarks, either of those or the control list, the full redacted address,
 * and a snapshot counter — and they disagreed in both directions.
 */
export function sameView(a: string, b: string): boolean {
  return viewOf(a) === viewOf(b);
}

/** An address that does not parse is compared as written. */
function viewOf(raw: string): string {
  try {
    const u = new URL(redactUrl(raw));
    u.hash = '';
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * The page's address as the user sees it, minus anything that looks like a
 * credential.
 *
 * This used to be `origin + pathname`, which silently dropped the query and the
 * fragment. That is not a small omission here: `?tab=issues`,
 * `?region=us-east-1` and `#/settings` are often the only thing that tells a
 * console page apart from its siblings, and the flow owner compares against
 * `tab.url`, which does carry them — so the two views of "where are we"
 * disagreed.
 *
 * Restoring them means the address travels to the user's model endpoint intact,
 * so the parameters that carry secrets are removed first. This is not a general
 * secret scanner and must not be described as one: it strips the conventional
 * names, which is where tokens in URLs actually live, and nothing more.
 */
/**
 * Exact names and suffixes only — never a substring search.
 *
 * A looser pattern destroys ordinary page context, and the losses land exactly
 * where this product is weakest: `?stock_code=` is a data source's identity,
 * `?error_code=` is what a diagnosis needs, `?sort_key=` is the DynamoDB
 * console, and `author` / `keyword` merely contain `auth` / `key`.
 *
 * Bare `code` is deliberately absent. An OAuth `?code=` is short-lived and
 * single-use, so keeping it costs little; matching it would redact every
 * product code, country code and error code on the web.
 */
const SECRET_NAMES = new Set(
  [
    'token', 'access_token', 'accesstoken', 'id_token', 'idtoken', 'refresh_token',
    'auth_token', 'authtoken', 'authorization', 'api_key', 'apikey', 'access_key',
    'secret', 'client_secret', 'secret_key', 'password', 'passwd', 'pwd', 'pass',
    'sig', 'signature', 'session', 'sessionid', 'session_id', 'jsessionid',
    'phpsessid', 'credential', 'credentials', 'otp', 'code_verifier',
  ].map((s) => s.toLowerCase()),
);

const SECRET_SUFFIX = /(_|-)?(token|secret|signature|password)s?$/i;

/**
 * `code` alone is a product code, a country code, an error code. `code` next to
 * `state` is an OAuth authorization code — the most valuable thing that ever
 * travels in a URL.
 *
 * The companion parameter is what makes the two decidable apart, so it is what
 * the rule keys on. A blanket `code` rule would redact `?stock_code=` and
 * `?error_code=` on exactly the pages this product exists to explain.
 */
const OAUTH_COMPANIONS = ['state', 'code_verifier', 'session_state', 'id_token', 'access_token'];

const isSecretParam = (k: string, oauth: boolean): boolean => {
  const lk = k.toLowerCase();
  if (oauth && lk === 'code') return true;
  return SECRET_NAMES.has(lk) || SECRET_SUFFIX.test(k);
};

function redactParams(p: URLSearchParams): boolean {
  const oauth = OAUTH_COMPANIONS.some((c) => p.has(c));
  let hit = false;
  for (const k of [...p.keys()])
    if (isSecretParam(k, oauth)) {
      p.set(k, 'REDACTED');
      hit = true;
    }
  return hit;
}

export function redactUrl(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }

  // `https://github.com@evil.com` reads as GitHub to a human and resolves to
  // evil.com. Always stripped, and always a reason to distrust the link.
  const hadUserinfo = Boolean(u.username || u.password);
  u.username = '';
  u.password = '';

  const hitQuery = redactParams(u.searchParams);
  // The fragment is where implicit OAuth returns tokens, and it is also where
  // SPA routes live — frequently in the same string, which is why an earlier
  // "only rewrite a fragment that is entirely parameters" rule let
  // `#/callback?id_token=…` through untouched.
  //
  // Splitting on `?` serves both: the route keeps its shape and the parameters
  // get the same treatment as the query. Round-tripping the whole fragment
  // through `URLSearchParams` — the obvious shortcut — turns `#/callback?x`
  // into `#%2Fcallback%3Fx` and destroys the one field that tells two SPA views
  // apart.
  let hitHash = false;
  const frag = u.hash.slice(1);
  if (frag.includes('=')) {
    const cut = frag.indexOf('?');
    const route = cut >= 0 ? frag.slice(0, cut) : '';
    const f = new URLSearchParams(cut >= 0 ? frag.slice(cut + 1) : frag);
    if (redactParams(f)) {
      u.hash = `#${route}${cut >= 0 ? '?' : ''}${f.toString()}`;
      hitHash = true;
    }
  }

  // Nothing matched: return the input untouched rather than `URL`'s normalised
  // re-serialisation, which changes percent-encoding and breaks the verbatim
  // comparisons this value takes part in.
  return hadUserinfo || hitQuery || hitHash ? u.toString() : href;
}
