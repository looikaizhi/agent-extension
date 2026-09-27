import { createHash } from 'node:crypto';
import type { GuideContext } from '@/agent/agents/guide/agent';
import { PLUGINS, contributionsFor } from '@/agent/context/plugins';
import type { PromptTable } from '@/core/extractor/types';
import { makeRef } from '@/shared/types';
import { renderedCall } from './rendered';

/**
 * Which version of "what the guide agent sends the model" an eval result was
 * produced with: a hash of the three strings the model actually reads — the
 * system message, the user message, and the tool schema — rendered by the code
 * that is running now.
 *
 * Two results are directly comparable only when this matches; when it does
 * not, part of the difference between them is the prompt. Computed rather
 * than read from the frozen snapshot: that file is only as current as the last
 * unit-test run, and it lives under `tests/`, which is not versioned.
 *
 * **Three strings, and deliberately nothing else.** This used to hash the
 * whole request — every message object and the request options with it — which
 * answered a different question than the one it was asked: it moved whenever
 * the *way* the request was sent changed, even with the prompt untouched to
 * the byte. Sending is a wire format's business, and this product now speaks
 * more than one; a fingerprint that a protocol can move would print "the
 * prompt differs" on every run after a refactor that changed no prompt, and
 * would retire every historical run's comparability along with it. The three
 * strings are protocol-independent, so adding a protocol cannot reach this —
 * `architecture.spec.ts` holds that by keeping the provider layer out of this
 * file's imports entirely.
 *
 * > 口径改于 2026-09-24（旧口径下本仓最后一个值是 `3b8dfa64353b10a5`）。两种口
 * > 径算出来的哈希不可互比——不是因为提示词变了，而是因为问的问题变了。
 *
 * The user message comes from one fixed input with every registered Plugin's
 * paragraph in it: a changed Skill text is a changed prompt, whichever Plugins
 * a given run turns on.
 */

const TABLE: PromptTable = {
  snapshotId: 'fingerprint',
  url: 'https://github.com/n8n-io/n8n',
  title: 'GitHub - n8n-io/n8n',
  structureHash: 'fingerprint',
  items: [
    { ref: makeRef(0, 1), role: 'combobox', name: 'Search or jump to', path: [] },
    { ref: makeRef(0, 2), role: 'link', name: 'Issues', path: ['Repository'] },
    { ref: makeRef(0, 3), role: 'link', name: 'Pull requests', path: ['Repository'] },
    { ref: makeRef(0, 4), role: 'button', name: 'Code', path: ['Repository'] },
  ],
  omitted: 0,
  degraded: false,
  ambiguity: 0,
  stats: {
    elementsScanned: 0,
    candidates: 0,
    visible: 0,
    emitted: 0,
    shadowRoots: 0,
    emptyName: 0,
    modalScoped: false,
    ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
  },
};

/** One confirmed step, a route, a fresh ref and every Plugin's paragraph:
 *  each part of the user message has something in it to hash. */
const CONTEXT: GuideContext = {
  goal: '带我去看这个仓库的 issue 列表',
  table: TABLE,
  history: {
    done: [{ title: 'n8n-io/n8n', url: 'https://github.com/search?q=n8n', action: 'taken', effect: { kind: 'moved', to: TABLE.url } }],
    route: [{ at: '仓库主页', goal: '打开 issue 列表' }],
  },
  contributions: contributionsFor(PLUGINS, TABLE.url),
  freshRefs: [makeRef(0, 4)],
};

/**
 * Synchronous, and no longer driven through the run loop against a scripted
 * endpoint. Rendering is all this needs, so a fake `complete` was one more
 * thing to keep in step with the shape of a delta — it had already been
 * rewritten once for that reason and was about to be again.
 */
export function fingerprint(): string {
  return createHash('sha256').update(JSON.stringify(renderedCall(CONTEXT))).digest('hex').slice(0, 16);
}
