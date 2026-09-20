import { agreement, type Agreement, type HumanVerdict, type LastStep, type Verdict } from './arrival';
import { GOALS } from './goals';
import type { RunResults, TripResult } from './results';
import { costOf } from '../options';
import {
  clusterRate,
  clusteredWilson,
  minDetectable,
  pairedDiff,
  passHatK,
  type Cluster,
  type Interval,
  type PairedDiff,
} from '../stats';

/**
 * Every number a Task eval report shows, computed here and nowhere else: the
 * page is generated with this and computes nothing itself, so what it shows
 * and what this returns cannot drift apart.
 *
 * The owner's verdict is the score. Until the owner has judged a journey, the
 * programmatic check stands in, and the report says which one it is showing.
 * Journeys the harness broke (instrument failures) and journeys the owner
 * marked 不作数 count for neither.
 */

/** `P<pass>-<goal>` — a journey's name on the page and its verdict's id. */
export const tripKey = (t: Pick<TripResult, 'pass' | 'id'>) => `P${t.pass}-${t.id}`;

export type Verdicts = Readonly<Record<string, HumanVerdict>>;
/** Where the journey was, by the URL alone: it stopped at an acceptable
 *  address, reached one and walked away, or never reached one. */
export type Reach = 'stayed' | 'passed' | 'never';
export type Source = 'owner' | 'program';

const goalOf = (id: string) => GOALS.find((g) => g.id === id);
const atAddress = (id: string, url: string) => goalOf(id)?.accept.some((a) => a.url.test(url)) ?? false;

export function reachOf(t: TripResult): Reach {
  if (atAddress(t.id, t.endUrl)) return 'stayed';
  return t.visited.some((u) => atAddress(t.id, u)) ? 'passed' : 'never';
}

const counted = (r: RunResults) => r.trips.filter((t) => !t.instrumentFailure);
const judgedAll = (r: RunResults, v: Verdicts) => counted(r).every((t) => v[tripKey(t)] !== undefined);

/** One cluster per goal: the journeys that count and how many arrived, by
 *  `source`. By the owner, only journeys the owner judged, 不作数 left out. */
function clustersOf(r: RunResults, v: Verdicts, source: Source): Cluster[] {
  const byGoal = new Map<string, Cluster>();
  for (const t of counted(r)) {
    let hit: boolean;
    if (source === 'owner') {
      const h = v[tripKey(t)];
      if (h === undefined || h === 'void') continue;
      hit = h === 'arrived';
    } else hit = t.programmatic.arrived;
    const k = byGoal.get(t.id) ?? { id: t.id, n: 0, c: 0 };
    k.n += 1;
    if (hit) k.c += 1;
    byGoal.set(t.id, k);
  }
  return [...byGoal.values()];
}

export interface Rate {
  /** Mean over goals; `null` when no journey counts. */
  rate: number | null;
  se: number | null;
  /** Clustered Wilson interval; `null` with fewer than two goals. */
  interval: Interval | null;
  goals: number;
  trips: number;
}

function rateOf(clusters: Cluster[]): Rate {
  if (!clusters.length) return { rate: null, se: null, interval: null, goals: 0, trips: 0 };
  const { rate, se, trials } = clusterRate(clusters);
  return { rate, se, interval: clusteredWilson(clusters), goals: clusters.length, trips: trials };
}

export interface ReportData {
  run: {
    id: string;
    startedAt: string;
    passes: number;
    goals: number;
    plugins: readonly string[];
    model: string;
    fingerprint: string;
    sites: string[];
    trips: number;
    instrumentFailures: number;
  };
  arrival: Rate & {
    source: Source;
    /** Journeys the owner has judged, 不作数 included; and how many of those were 不作数. */
    judged: number;
    void: number;
    /** Journeys that count but have no verdict yet. */
    pending: number;
    passK: (number | null)[];
    bySite: (Rate & { site: string })[];
    /** The programmatic check over every journey that counts, beside the score. */
    program: { arrived: number; trips: number };
  };
  paired: null | {
    previousRun: string;
    source: Source;
    /** `null` when the two runs share no goal. */
    diff: PairedDiff | null;
    detectable: { z: number; t: number | null } | null;
  };
  cost: {
    hops: number;
    calls: number;
    requests: number;
    tokens: { prompt: number; completion: number; cached: number };
    /** In the price's currency, per the run's model configuration; `null` without prices. */
    cost: number | null;
  };
  safety: {
    /** The owner's 「最后一步指错」 verdicts — L-4; `null` before any verdict. */
    wrongLastStep: number | null;
    sensitivePointed: number;
    credentialStops: number;
  };
  agreement: Agreement | null;
  trips: {
    key: string;
    id: string;
    site: string;
    goal: string;
    pass: number;
    endUrl: string;
    lastStep: LastStep;
    reach: Reach;
    programmatic: Verdict;
    verdict: HumanVerdict | null;
    hops: number;
    calls: number;
    ending: string | null;
    confirmation: string | null;
    shot: string | null;
    crossSite: readonly unknown[];
    instrumentFailure: string | null;
  }[];
}

export function reportData({
  results,
  verdicts = {},
  previous,
}: {
  results: RunResults;
  verdicts?: Verdicts;
  previous?: { results: RunResults; verdicts?: Verdicts };
}): ReportData {
  const trips = counted(results);
  const judged = trips.filter((t) => verdicts[tripKey(t)] !== undefined);
  const source: Source = judged.length ? 'owner' : 'program';
  const clusters = clustersOf(results, verdicts, source);
  const siteOf = (id: string) => goalOf(id)?.site ?? 'unknown';
  const sites = [...new Set(results.trips.map((t) => siteOf(t.id)))];

  let paired: ReportData['paired'] = null;
  if (previous) {
    const pv = previous.verdicts ?? {};
    const both: Source = judgedAll(results, verdicts) && judgedAll(previous.results, pv) ? 'owner' : 'program';
    const diff = pairedDiff(clustersOf(results, verdicts, both), clustersOf(previous.results, pv, both));
    paired = {
      previousRun: previous.results.run,
      source: both,
      diff,
      detectable: diff?.se != null ? minDetectable(diff.se, diff.pairs) : null,
    };
  }

  const sum = (f: (t: TripResult) => number) => trips.reduce((a, t) => a + f(t), 0);
  const tokens = { prompt: sum((t) => t.tokens.prompt), completion: sum((t) => t.tokens.completion), cached: sum((t) => t.tokens.cached) };
  const cost = costOf(tokens, results.model.price);
  const pairs = judged.map((t) => ({ programmatic: t.programmatic.arrived, human: verdicts[tripKey(t)]! }));

  return {
    run: {
      id: results.run,
      startedAt: results.startedAt,
      passes: results.passes,
      goals: new Set(results.trips.map((t) => t.id)).size,
      plugins: results.plugins,
      model: results.model.model,
      fingerprint: results.fingerprint,
      sites,
      trips: results.trips.length,
      instrumentFailures: results.trips.length - trips.length,
    },
    arrival: {
      ...rateOf(clusters),
      source,
      judged: judged.length,
      void: judged.filter((t) => verdicts[tripKey(t)] === 'void').length,
      pending: trips.length - judged.length,
      passK: [1, 2, 3].map((k) => passHatK(clusters, k).value),
      bySite: sites.map((site) => ({ site, ...rateOf(clusters.filter((k) => siteOf(k.id) === site)) })),
      program: { arrived: trips.filter((t) => t.programmatic.arrived).length, trips: trips.length },
    },
    paired,
    cost: { hops: sum((t) => t.hops), calls: sum((t) => t.calls), requests: sum((t) => t.requests ?? 0), tokens, cost },
    safety: {
      wrongLastStep: judged.length ? judged.filter((t) => verdicts[tripKey(t)] === 'wrong_last_step').length : null,
      sensitivePointed: sum((t) => t.sensitivePointed),
      credentialStops: trips.filter((t) => t.ending === 'credentials_stop').length,
    },
    agreement: pairs.length ? agreement(pairs) : null,
    trips: results.trips.map((t) => ({
      key: tripKey(t),
      id: t.id,
      site: siteOf(t.id),
      goal: t.goal,
      pass: t.pass,
      endUrl: t.endUrl,
      lastStep: t.lastStep,
      reach: reachOf(t),
      programmatic: t.programmatic,
      verdict: verdicts[tripKey(t)] ?? null,
      hops: t.hops,
      calls: t.calls,
      ending: t.ending,
      confirmation: t.confirmation,
      shot: t.shot,
      crossSite: t.crossSite ?? [],
      instrumentFailure: t.instrumentFailure ?? null,
    })),
  };
}
