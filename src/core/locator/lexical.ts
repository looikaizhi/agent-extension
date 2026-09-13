import type { PromptItem } from '@/core/extractor/types';

/**
 * Deterministic local scoring. Lives in `core/` rather than `agent/` because
 * lexical matching is a local computation over what we can already see — it is
 * "looking", not "thinking".
 *
 * Two consumers: the step-1 zero-cost baseline, and step 2's `relocate` node,
 * where it is the reason most relocations cost nothing.
 */
export interface ScoredNode {
  item: PromptItem;
  score: number;
  signals: string[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const t = new Set<string>();
  const p = ` ${s} `;
  for (let i = 0; i < p.length - 2; i++) t.add(p.slice(i, i + 3));
  return t;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const CJK = /[一-鿿぀-ヿ가-힯]/;

/**
 * Query tokens, for the word-overlap branch.
 *
 * Splitting on spaces is the whole story for English and none of it for CJK,
 * which is not space-delimited: `"怎么进入开发文档".split(' ')` is one token, so
 * the word branch never fired and the flat `substring` floor below was the only
 * thing scoring a Chinese query. Character bigrams are the standard stand-in
 * for a segmenter here — they are what lets "开发文档" reach "开发者文档中心".
 *
 * CJK runs are dropped from the space-split set once their bigrams are added,
 * or the untokenised run would sit in the denominator diluting every hit.
 */
function tokensOf(s: string): Set<string> {
  const out = new Set(s.split(' ').filter((w) => w.length > 1 && !CJK.test(w)));
  if (CJK.test(s)) {
    for (const run of s.split(/[^一-鿿぀-ヿ가-힯]+/)) {
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

export function scoreNodes(query: string, items: readonly PromptItem[]): ScoredNode[] {
  const q = normalize(query);
  if (!q) return [];
  const qt = trigrams(q);
  const qWords = tokensOf(q);

  const out: ScoredNode[] = [];
  for (const item of items) {
    if (item.sensitive) continue; // never propose a credential field as a target
    const name = normalize(item.name);
    if (!name) continue;

    const signals: string[] = [];
    let score = 0;

    if (name === q) {
      score = 1;
      signals.push('exact');
    } else {
      const sim = jaccard(qt, trigrams(name));
      score = sim * 0.8;
      if (sim > 0) signals.push(`trigram:${sim.toFixed(2)}`);

      if (name.includes(q)) {
        // The whole query appears in this name: strong, and unchanged.
        score = Math.max(score, 0.7);
        signals.push('substring');
      } else if (q.includes(name)) {
        // The name is a *fragment* of the query, and the two ways that happens
        // are not equally good evidence.
        //
        // Aligned on whitespace, it is as strong as before: "Stop" inside "stop
        // the running instance" is the user naming the control.
        //
        // Sitting inside a larger token, it is not: "文档" inside "开发文档" is a
        // piece of a compound that names something else, and CJK has no spaces
        // to tell the two cases apart. Under the old flat 0.7 the short nav
        // label beat the long name that actually matched — and beat it as a
        // *unique* result, which is L-4.
        //
        // Scaling only the unaligned case is what keeps both: a first cut that
        // scaled both regressed four English natural-language queries, and the
        // eval could not see it (its 20 goals are all 2–4 word phrases).
        const at = q.indexOf(name);
        const before = at === 0 ? ' ' : q[at - 1]!;
        const after = at + name.length >= q.length ? ' ' : q[at + name.length]!;
        const aligned = /\s/.test(before) && /\s/.test(after);
        score = Math.max(score, aligned ? 0.7 : 0.7 * (name.length / q.length));
        signals.push(aligned ? 'substring' : 'fragment');
      }
      let hits = 0;
      for (const w of qWords) if (name.includes(w)) hits += 1;
      if (hits) {
        score = Math.max(score, (hits / qWords.size) * 0.75);
        signals.push(`words:${hits}/${qWords.size}`);
      }
    }

    // A path hit is weak evidence on its own but breaks ties well.
    for (const p of item.path) {
      if (normalize(p) && q.includes(normalize(p))) {
        score += 0.05;
        signals.push('path');
        break;
      }
    }

    if (score > 0.05) out.push({ item, score: Math.min(1, score), signals });
  }

  return out.sort((a, b) => b.score - a.score);
}
