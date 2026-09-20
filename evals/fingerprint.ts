import { createHash } from 'node:crypto';
import type { GuideContext } from '@/agent/agents/guide/agent';
import { runGuideToEnd } from '@/agent/agents/guide/runner';
import { PLUGINS, contributionsFor } from '@/agent/context/plugins';
import type { ChatMessage, CompleteOptions, Delta, complete } from '@/agent/provider/provider';
import type { PromptTable } from '@/core/extractor/types';
import { DEFAULT_CONFIG } from '@/shared/settings';
import { makeRef } from '@/shared/types';

/**
 * Which version of "what the guide agent sends the model" an eval result was
 * produced with: a hash of the system message, the tool schema and a user
 * message, computed from the code that is running now.
 *
 * Two results are directly comparable only when this matches; when it does
 * not, part of the difference between them is the prompt. Computed rather
 * than read from the frozen snapshot: that file is only as current as the last
 * unit-test run, and it lives under `tests/`, which is not versioned.
 *
 * The request is built by the real run loop against a recording `complete` —
 * the way the snapshot test captures it — so what is hashed is what would go
 * out, request options and all. The user message comes from one fixed input
 * with every registered Plugin's paragraph in it: a changed Skill text is a
 * changed prompt, whichever Plugins a given run turns on.
 */

/** The wrapper's random marker, pinned so the rest can be compared. */
const NONCE = '00000000-0000-4000-8000-000000000000';

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

export async function fingerprint(): Promise<string> {
  const sent: { messages: ChatMessage[]; options?: CompleteOptions }[] = [];
  async function* recording(
    _cfg: unknown,
    messages: ChatMessage[],
    _signal: AbortSignal,
    options?: CompleteOptions,
  ): AsyncGenerator<Delta> {
    sent.push({ messages, ...(options ? { options } : {}) });
    yield {
      content: '',
      tool: { index: 0, id: 'call_done', name: 'done', arguments: JSON.stringify({ evidence: 'content_on_page', why: '指纹' }) },
    };
  }
  await runGuideToEnd(CONTEXT, DEFAULT_CONFIG, new AbortController().signal, recording as typeof complete, undefined, () => NONCE);
  // A second request would be the repair round: the scripted answer stopped
  // being valid, and the hash would cover a repair prompt nobody meant to pin.
  if (sent.length !== 1) throw new Error(`指纹：运行循环发了 ${sent.length} 次请求，应当恰好 1 次`);
  return createHash('sha256').update(JSON.stringify(sent[0])).digest('hex').slice(0, 16);
}
