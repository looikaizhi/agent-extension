/**
 * Is the next step still on the site the user is looking at?
 *
 * Exact hostname equality, and nothing else. No public-suffix list, no
 * registrable-domain reduction, no attempt to decide whether two hosts belong
 * to the same organisation. `console.aws.amazon.com` → `docs.aws.amazon.com`
 * **is** a cross-site hop under this rule and will ask for confirmation.
 *
 * That is a deliberate tightening, not an oversight. "Are these two hosts the
 * same party" is precisely the question P-1 (brand/host mismatch) was deferred
 * for: there is no reliable way to extract the party a page claims to be, and
 * a wrong answer here is worse than an extra confirmation. So this asks the
 * one question that has a definite answer, and over-asks rather than guesses.
 *
 * Anything unparseable answers `false` — an address we cannot read is an
 * address we cannot vouch for, and the cost of asking once more is a click.
 */
export function sameHost(a: string, b: string): boolean {
  const host = (raw: string): string | null => {
    try {
      const h = new URL(raw).hostname;
      return h === '' ? null : h.toLowerCase();
    } catch {
      return null;
    }
  };
  const left = host(a);
  const right = host(b);
  return left !== null && right !== null && left === right;
}

/**
 * The four structural red flags (V-1…V-4), shared by doc fetching (06) and
 * cross-site navigation (07).
 *
 * One implementation on purpose: two copies would let one of them be weakened
 * without the other noticing, and the one that got weakened would be the one
 * nobody was looking at.
 *
 * Structural means exactly that — every check answers a question about the
 * URL's own shape, not about who owns it or whether they are trustworthy.
 * That question stays deferred with P-1.
 */
export type RedFlag = 'userinfo' | 'scheme' | 'private_network' | 'homograph';

/** RFC 1918 + loopback + link-local, in the forms a URL can carry them. */
const PRIVATE_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?fc|\[?fd)/i;

/**
 * Takes only the URL. 06's plan sketched a `currentHost` parameter, but none
 * of V-1…V-4 needs it: every one is a question about the address's own shape.
 * The only check that *would* use it — "is this hostname imitating the site
 * I am on" — is P-1, which stayed deferred. A parameter nothing reads is a
 * promise the signature cannot keep.
 */
export function structuralRedFlags(url: URL): RedFlag | null {
  // V-3 first: everything below assumes a web address. `data:` and `file:`
  // are not somewhere a page can honestly link a user to for documentation.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme';

  // V-2: `https://console.example.test@evil.test/` reads as the official site
  // and goes to evil.test. The oldest disguise there is, and still effective.
  if (url.username !== '' || url.password !== '') return 'userinfo';

  const host = url.hostname.toLowerCase();

  // V-4: a documentation link that points inside the user's own network is
  // never documentation. Also keeps `fetchDoc` from being a probe.
  if (PRIVATE_HOSTS.test(host)) return 'private_network';

  // V-1: `аpple.com` (Cyrillic а) is indistinguishable from `apple.com` on
  // screen. We deliberately do **not** decide *who* it is imitating — that is
  // P-1's deferred question. We only say the hostname is not plain ASCII, so
  // we cannot read it reliably. `xn--` is the same fact after encoding.
  if (host.startsWith('xn--') || host.includes('.xn--') || /[^\x00-\x7f]/.test(host)) return 'homograph';

  return null;
}
