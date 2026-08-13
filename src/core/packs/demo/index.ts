import type { GuidePack } from '../types';
import { githubSshPack } from './github';

/** Step 1 ships packs as TS modules. A YAML loader arrives with M-06 (remote
 *  community packs); adding it now would be speculative configuration. */
export const DEMO_PACKS: GuidePack[] = [githubSshPack];
