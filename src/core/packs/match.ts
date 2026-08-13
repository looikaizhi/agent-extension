import type { GuidePack, PackFlow } from './types';
import { DEMO_PACKS } from './demo';

export function packsFor(url: string): GuidePack[] {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  return DEMO_PACKS.filter((p) =>
    p.match.domains.some((d) => host === d || host.endsWith(`.${d}`)),
  );
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function matchFlow(url: string, goal: string): { pack: GuidePack; flow: PackFlow } | null {
  const g = norm(goal);
  if (!g) return null;
  for (const pack of packsFor(url)) {
    for (const flow of pack.flows) {
      if (flow.goalAliases.some((a) => g.includes(norm(a)) || norm(a).includes(g)))
        return { pack, flow };
    }
  }
  return null;
}
