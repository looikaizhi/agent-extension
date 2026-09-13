import { isFlagOn, type FlagStore } from '@/agent/flags';
import { skill } from '@/agent/skills';

/**
 * A `Plugin` (CONTEXT.md): an agent capability with a name and a default, that
 * can be switched on or off on its own — so "with it / without it" can be
 * measured.
 *
 * Spec A opens one seam only: adding a paragraph to the guide's Context. What
 * the enabled Plugins add is collected on the host when a model call is sent —
 * reading the switches is a storage read, and the reducer does no I/O — and
 * travels with the request (`CallModelParams.contributions`). The reducer does
 * not know Plugins exist.
 *
 * A run is made with one set: the switches are read when it starts and that
 * set is used for every call it sends and written into its Run record
 * (`thread/writer.ts`), so an eval can put a result down to one combination.
 *
 * Adding one is its own directory and one line in `PLUGINS`.
 */
export interface Plugin {
  /** Its switch (`plugin:<name>`) and its entry in a Run record. */
  readonly name: string;
  /** Whether it is on when its switch says nothing. */
  readonly defaultOn: boolean;
  /** Its paragraph for the guide's user message on a page at `url`, or
   *  `undefined` when it has nothing for this page. */
  contextFor(url: string): string | undefined;
}

/** Every Plugin, in the order their paragraphs appear. */
export const PLUGINS: readonly Plugin[] = [skill];

/** Where a Plugin's switch lives — `storage.local`, beside the trace switch,
 *  so a harness can set it before a run. */
export const pluginKey = (name: string) => `plugin:${name}`;

/**
 * The Plugins that are on: the stored switch when there is one, the Plugin's
 * default when there is not. A read that fails counts as "not set" — the
 * defaults are what the product ships with, and a storage hiccup is no reason
 * to change what a model call is told.
 */
export async function enabledPlugins(flags: FlagStore): Promise<readonly Plugin[]> {
  const on = await Promise.all(PLUGINS.map((p) => isFlagOn(flags, pluginKey(p.name), p.defaultOn)));
  return PLUGINS.filter((_, i) => on[i]);
}

/** The registered Plugins among `names`, in registry order — a run's stored
 *  set, back as Plugins. */
export function pluginsNamed(names: readonly string[]): readonly Plugin[] {
  return PLUGINS.filter((p) => names.includes(p.name));
}

/** What the given Plugins add to the Context of a call on a page at `url`. */
export function contributionsFor(plugins: readonly Plugin[], url: string): string[] {
  return plugins.map((p) => p.contextFor(url)).filter((t): t is string => t !== undefined);
}
