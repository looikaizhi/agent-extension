import { asAppearance, type Appearance } from './appearance';

/**
 * Where the appearance is kept. Its own key, apart from `provider`: it is a
 * preference of the person, not a property of an endpoint — and the page side,
 * which needs the appearance, must never be handed the object the key lives in.
 */
export const APPEARANCE_KEY = 'appearance';

export async function loadAppearance(): Promise<Appearance> {
  return asAppearance((await chrome.storage.local.get(APPEARANCE_KEY))[APPEARANCE_KEY]);
}

export async function saveAppearance(a: Appearance): Promise<void> {
  await chrome.storage.local.set({ [APPEARANCE_KEY]: a });
}

/** Calls `fn` whenever the appearance is saved, from whichever context saved it.
 *  Returns the unsubscribe. */
export function onAppearanceChanged(fn: (a: Appearance) => void): () => void {
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
    const change = changes[APPEARANCE_KEY];
    if (area === 'local' && change) fn(asAppearance(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
