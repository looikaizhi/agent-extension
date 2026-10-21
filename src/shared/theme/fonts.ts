import sans from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline';
import mono from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline';

/**
 * 夜航's two typefaces (Geist, Geist Mono), for the side panel and for the
 * overlay on the page alike.
 *
 * Registered under names of our own, so a page that ships its own Geist —
 * many do — never lends it to us or borrows ours. Latin only: Chinese is set
 * in the system's face in both looks, and the latin subsets are ~50 KB together.
 *
 * Handed over as bytes rather than as a URL: a page's CSP decides which URLs
 * may serve it a font, and bytes are not a URL. That is also why this works
 * inside the overlay's shadow root — faces added to `document.fonts` reach
 * every tree in the document, where an `@font-face` inside the shadow root
 * would not.
 */
export const HUD_SANS = 'PG Geist';
export const HUD_MONO = 'PG Geist Mono';

/** Basic Latin, Latin-1 and the punctuation Geist's latin subset carries. */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

const bytesOf = (dataUrl: string): ArrayBuffer => {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = new Uint8Array(b64.length);
  const raw = atob(b64);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer.slice(0, raw.length);
};

const added = new WeakSet<Document>();

/** Adds both faces to `doc`, once per document. */
export function addHudFonts(doc: Document): void {
  if (added.has(doc)) return;
  added.add(doc);
  for (const [family, data] of [
    [HUD_SANS, sans],
    [HUD_MONO, mono],
  ] as const) {
    const face = new FontFace(family, bytesOf(data), { weight: '100 900', unicodeRange: LATIN, display: 'swap' });
    doc.fonts.add(face);
    void face.load().catch(() => {
      /* a face that will not parse leaves the system font in place */
    });
  }
}
