import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PRESETS } from '@/shared/settings';
import {
  ACTING_RULES,
  N2_RULES,
  actingOffenders,
  actingWords,
  callsReducerStep,
  chainHas,
  factsOf,
  factsOfText,
  importClosure,
  importsRunner,
  purityOffenders,
  lastSegment,
  partyGuessing,
  reexportsReducerStep,
  runnerImport,
  sourceFiles,
  type Facts,
} from './fixtures/source-scan';

/**
 * Replaces ESLint with three assertions that actually matter here. Each guards
 * an invariant that would decay silently: nobody notices a slow extractor until
 * a console page janks, and nobody notices an S-05 leak until an audit.
 *
 * Every guard reads the source the way the compiler parses it (`factsOf`), not
 * as text — so a comment, a string that looks like code, and an aliased import
 * are each seen for what they are. And every guard checks itself twice: its
 * file scope must match at least one file (a scope that matches nothing passes
 * vacuously, which is how a guard dies unnoticed), and its detector must fire
 * somewhere it is allowed to — in the tree when such a place exists, on a
 * synthetic violation below when it does not.
 */

const SRC = join(process.cwd(), 'src');
const PROTOCOLS_DIR = join(SRC, 'agent', 'provider', 'protocols');

/** The same walk `gates.spec.ts` uses — one list of what counts as source. */
const files = sourceFiles();
const read = (p: string) => readFileSync(p, 'utf8');
const rel = (f: string) => f.replace(`${process.cwd()}/`, '');

function scope(label: string, pick: (f: string) => boolean): string[] {
  const picked = files.filter(pick);
  expect(picked.length, `${label}：作用范围一个文件都没匹配到——守卫在空集上恒真`).toBeGreaterThan(0);
  return picked;
}
const offending = (inScope: string[], pred: (f: Facts) => boolean) => inScope.filter((f) => pred(factsOf(f))).map(rel);
function alive(label: string, pred: (f: Facts) => boolean): void {
  expect(files.filter((f) => pred(factsOf(f))).length, `${label}：判据在整棵源码树上一处都没命中——它可能已经瞎了`).toBeGreaterThan(0);
}

const methodCalls = (f: Facts, name: string) => f.calls.filter((c) => c.chain.includes('.') && lastSegment(c.chain) === name);
const reaches = (f: Facts, path: string) => f.accesses.some((a) => chainHas(a, path));
const SECURE_ONLY = ['crypto.randomUUID', 'crypto.subtle', 'navigator.clipboard', 'navigator.locks'];

/** Each guard's question, asked once and used both on the tree and on the synthetic violations below. */
const detect = {
  computedStyle: (f: Facts) => f.calls.some((c) => lastSegment(c.chain) === 'getComputedStyle'),
  readsValue: (f: Facts) => f.accesses.some((a) => lastSegment(a) === 'value'),
  sorts: (f: Facts) => methodCalls(f, 'sort').length > 0,
  scores: (f: Facts) => [...f.names].some((n) => /score/i.test(n)),
  takesFirst: (f: Facts) => f.calls.some((c) => lastSegment(c.chain) === 'slice' && c.args.join(',').replace(/\s/g, '') === '0,1'),
  secureContext: (f: Facts) => SECURE_ONLY.some((b) => reaches(f, b)),
  liveViewport: (f: Facts) =>
    f.accesses.some((a) => a.startsWith('window.') || a.startsWith('document.')) ||
    ['visualViewport', 'scrollY', 'scrollX', 'getBoundingClientRect'].some((n) => f.names.has(n)),
  focuses: (f: Facts) => methodCalls(f, 'focus').length > 0,
  network: (f: Facts) =>
    f.calls.some((c) => ['fetch', 'sendBeacon'].includes(lastSegment(c.chain))) ||
    f.names.has('XMLHttpRequest') ||
    f.news.some((n) => lastSegment(n) === 'WebSocket'),
  extensionStorage: (f: Facts) => reaches(f, 'chrome.storage'),
  syncStorage: (f: Facts) => reaches(f, 'storage.sync'),
  keyNearLogs: (f: Facts) =>
    f.names.has('apiKey') && f.calls.some((c) => c.chain.startsWith('console.') || ['emit', 'broadcast'].includes(lastSegment(c.chain))),
  selection: (f: Facts) => ['getSelection', 'addRange', 'execCommand'].some((n) => f.names.has(n)),
  commandsContent: (f: Facts) => f.names.has('sendToTab') || reaches(f, 'chrome.tabs.sendMessage'),
  importsAgent: (f: Facts) => f.imports.some((i) => /^(?:@\/agent\/|(?:\.\.\/)+agent\/)/.test(i.module)),
  flowState: (f: Facts) => f.strings.some((s) => /^(?:thread|guide|effect):/.test(s)) || reaches(f, 'storage.session'),
  chrome: (f: Facts) => f.names.has('chrome'),
  importsCore: (f: Facts) => f.imports.some((i) => /^(?:@\/core\/|(?:\.\.\/)+core\/)/.test(i.module)),
  effectTags: (f: Facts) => [...f.strings, ...f.names].some((w) => /EFFECT_REQUEST|EFFECT_RESULT/.test(w)),
  senderIdentity: (f: Facts) => f.accesses.some((a) => lastSegment(a) === 'documentId') || f.names.has('documentIds'),
  /** Anything that makes the same input answer differently twice: a clock, a
   *  die, or the environment. */
  impure: (f: Facts) =>
    ['Date', 'process', 'performance'].some((n) => f.names.has(n)) ||
    f.calls.some((c) => ['now', 'random'].includes(lastSegment(c.chain))),
  runner: runnerImport,
};

/**
 * The top-level keys of every object literal sent as a request `body: JSON.stringify({ … })`.
 *
 * A spread whose contents are in plain sight — `...(tools ? { tools, tool_choice } : {})` — is
 * expanded, both branches of it, because that is exactly how the optional keys are sent. Only a
 * spread of something the source does not spell out is reported as `…`, since its keys cannot be
 * checked. The indentation-based pattern this replaced read neither: it saw the five keys at one
 * fixed depth and never the ones inside the spread, which is why those sat on the allowlist unchecked.
 */
function requestBodyKeys(src: string): string[] {
  const sf = ts.createSourceFile('provider.ts', src, ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  const collect = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return collect(e.expression);
    if (ts.isConditionalExpression(e)) {
      collect(e.whenTrue);
      collect(e.whenFalse);
      return;
    }
    if (!ts.isObjectLiteralExpression(e)) {
      keys.push(`…${e.getText(sf)}`);
      return;
    }
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) collect(p.expression);
      else keys.push(p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : `…${p.getText(sf)}`);
    }
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'body' &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'JSON.stringify'
    ) {
      const [obj] = n.initializer.arguments;
      if (obj) collect(obj);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return keys;
}

describe('架构护栏', () => {
  it('抽取器不得调用 getComputedStyle（性能护栏）', () => {
    expect(offending(scope('抽取器', (f) => f.includes(join('core', 'extractor'))), detect.computedStyle)).toEqual([]);
    // Nothing in the tree calls it, so its liveness is proven on a synthetic call below.
  });

  it('抽取管线不得读取输入框的 value（S-05）', () => {
    // `.value` on an <input> is the user's data and must never leave the page.
    // Boolean IDL attributes (checked/disabled/required) are fine.
    const pipeline = scope('抽取与安全', (f) => f.includes(join('core', 'extractor')) || f.includes(join('core', 'security')));
    expect(offending(pipeline, detect.readsValue)).toEqual([]);
    alive('.value', detect.readsValue);
  });

  it('绑定逻辑不得排序或打分（K-6）', () => {
    // Silent mis-binding can only be born from "pick one of several", and the
    // usual way that creeps in is a sort or a score. Indexing `candidates[0]`
    // is fine *inside* a length===1 branch, so that is covered behaviourally in
    // bind.spec.ts rather than by grep.
    const bind = scope('绑定', (f) => f.endsWith(join('core', 'descriptor', 'bind.ts')));
    expect(offending(bind, detect.sorts)).toEqual([]);
    expect(offending(bind, detect.scores)).toEqual([]);
    expect(offending(bind, detect.takesFirst)).toEqual([]);
    alive('排序', detect.sorts);
    alive('打分', detect.scores);
  });

  it('UINode 的字段白名单不含任何页面文本载体', () => {
    const types = join(SRC, 'core/extractor/types.ts');
    const sf = ts.createSourceFile(types, read(types), ts.ScriptTarget.Latest, true);
    const uinode = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'UINode');
    expect(uinode, 'UINode 不见了——这条守卫在空集上恒真').toBeDefined();
    const fields = uinode!.members.map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''));
    expect(fields.length).toBeGreaterThan(0);
    for (const banned of ['text', 'html', 'value', 'innerText', 'textContent']) expect(fields).not.toContain(banned);
  });

  it('页面侧代码不得依赖仅在安全上下文可用的 API', () => {
    // `crypto.randomUUID()` threw on every plain-http page with a normal
    // hostname, and nothing caught it: `localhost` and `127.0.0.1` *are* secure
    // contexts, so the entire fixture corpus and every measured real site
    // happened to be immune. Internal consoles on http:// are the target user.
    const pageSide = scope(
      '页面侧',
      (f) => f.includes(join('core', 'extractor')) || f.includes(join('core', 'overlay')) || f.endsWith(join('entrypoints', 'content.ts')),
    );
    expect(offending(pageSide, detect.secureContext)).toEqual([]);
    alive('安全上下文 API', detect.secureContext);
  });

  it('投影是纯函数：不得读取任何实时视口状态', () => {
    // The F-5 fix rests entirely on band maths coming from `view.viewport`
    // rather than from live globals — one `window.innerHeight` and `nth` is
    // scroll-dependent again. The unit tests run under `environment: 'node'`,
    // so such a read would surface as a confusing ReferenceError deep in a
    // fixture rather than as this sentence.
    expect(offending(scope('投影', (f) => f.endsWith(join('core', 'extractor', 'project.ts'))), detect.liveViewport)).toEqual([]);
    alive('实时视口', detect.liveViewport);
  });

  it('第一步不得引入任何 LLM / 编排依赖', () => {
    const pkg = JSON.parse(read(join(process.cwd(), 'package.json')));
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const d of deps) {
      expect(d).not.toMatch(/langchain|langgraph|openai|anthropic/i);
    }
  });

  /**
   * These two exist because the extension now holds `<all_urls>` from install.
   * "It only reads the page" is no longer something Chrome enforces for us — it
   * is a property of this source tree, and nothing else. So it gets asserted.
   */
  it('任何地方都不得操作页面（只指路，不开车）', () => {
    // The rules and the walk live in `fixtures/source-scan.ts`, shared with
    // D3's `executed` gate in `gates.spec.ts` — one fact, one implementation,
    // so the two cannot drift into disagreeing about it. Nothing in the tree
    // uses any of them, so each rule's liveness is proven on a synthetic
    // violation below.
    expect(actingOffenders()).toEqual([]);
  });

  /**
   * P-1（品牌—主机不匹配）被推迟了，这条守卫让「推迟」在代码里留不下痕迹。
   *
   * 跨站判定只用精确 hostname 比对（`core/security/link-safety.ts` 的
   * `sameHost`）。一旦有人引入公共后缀表、注册域归并、或任何「这两个 host 是
   * 不是同一家」的推断，这条就会红——那道题正是 P-1 被推迟的理由，不该从侧门
   * 溜回来。
   *
   * 看的是代码里的名字和字符串：说明「我们不做这个」的注释是文档，不是实现。
   */
  it('跨站判定里没有任何注册域/公共后缀推断（P-1 推迟不留痕迹）', () => {
    const offenders = scope('源码', (f) => !f.includes('tests')).flatMap((f) =>
      partyGuessing(factsOf(f)).map((re) => `${rel(f)} :: ${re}`),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * `focus()` is the one member of that list with a carve-out, and it is a
   * narrow one.
   *
   * The line the rest of the list draws is *activation*: `click`, `submit`,
   * `dispatchEvent` and a synthesized `KeyboardEvent` all make the page do
   * something on the user's behalf. `focus()` cannot — a focused button sits
   * there until a key is pressed, and that keystroke is a real user gesture
   * the page receives from the browser, not from us. That is what makes
   * 「跳到目标」 hand over the keyboard rather than take the wheel.
   *
   * It is not free of effect: the page's own `focus`/`focusin` handlers run,
   * and some sites open a menu on focus. So the permission is scoped to the
   * single call site that needs it, and this test fails the moment a second
   * one appears anywhere.
   */
  it("focus() 只在 content script 的「跳到目标」那一处，且只有一处", () => {
    const withFocus = files.filter((f) => !f.includes('tests')).filter((f) => detect.focuses(factsOf(f)));
    expect(withFocus.map(rel)).toEqual([join('src', 'entrypoints', 'content.ts')]);
    expect(methodCalls(factsOf(withFocus[0]!), 'focus')).toHaveLength(1);
  });

  it('content script 的指令集是封闭的，且没有执行类动词', async () => {
    // Adding a verb must be a deliberate act with a visible diff, not something
    // that arrives inside an unrelated change. `RPC_TYPES` is the runtime
    // whitelist `onRequest` enforces, and protocol.ts carries a compile-time
    // proof that it and `ContentRpcMap` cannot drift — so asserting the one
    // value covers both.
    //
    // `HostRequest`'s verbs (including the panel-relay pair `PANEL_EXTRACT` /
    // `PANEL_INSPECT` added when the side panel stopped talking to the content
    // script directly) are NOT in this list on purpose: that type is "who may
    // command the host", which is allowed to grow, while `RPC_TYPES` here is
    // "what the host may command the content script to do", which stays closed.
    //
    // `WAIT_FOR` joined for `wait_for` (07c): it watches the page's visible text
    // and answers when a piece of it appears or goes — a read that takes a while,
    // not an act. `WAITING_FOR_PANEL` joined in 06c: it puts one line on our own
    // overlay's card, telling the user to open the side panel so a model call
    // can run — it writes to nothing of the page's. `SAY` joined in 10c: it
    // puts a question, an answer, a cross-site confirmation or a closing note
    // on that same card of ours, and nothing of the page's. `THEME` joined with
    // the user's choice of look: it tells our overlay which style and shade to
    // paint in, because the content script cannot read storage — it recolours
    // our overlay and nothing of the page's.
    const { RPC_TYPES } = await import('@/shared/protocol');
    expect([...RPC_TYPES].sort()).toEqual(
      ['CLEAR', 'DEBUG_GET_OVERLAY_STATE', 'EXTRACT', 'HIGHLIGHT', 'INSPECT', 'PING', 'SAY', 'THEME', 'WAIT_FOR', 'WAITING_FOR_PANEL'].sort(),
    );
    for (const banned of ['EXECUTE', 'CLICK', 'FILL', 'TYPE', 'SUBMIT', 'NAVIGATE', 'EVAL']) {
      expect(RPC_TYPES as readonly string[]).not.toContain(banned);
    }
  });

  /**
   * Only pointing, never acting — held by structure, not by a line in the
   * prompt (CONTEXT.md `Tool`). A tool the model is never offered is a tool it
   * cannot call, whatever a page tells it to do. So nothing the registry
   * registers may be an act, and nothing the model is offered may be one —
   * on an ordinary call, and on a step's last call, which offers a different set.
   *
   * Turning on a mode that acts means registering `act` on purpose; this is
   * where that change is meant to be seen.
   */
  it('登记处里没有 act：模型能调用的每一个工具都不是替用户动手', async () => {
    const { GUIDE_INTENT_MODULES } = await import('@/agent/agents/guide/registry');
    const { guideAgent } = await import('@/agent/agents/guide/agent');
    const intents = GUIDE_INTENT_MODULES.map((m) => m.intent);
    expect(intents.length, '登记处：一个 intent 都没有——守卫在空集上恒真').toBeGreaterThan(0);

    const table = {
      snapshotId: 's', url: 'https://x.test/', title: 't', structureHash: 'h', omitted: 0, degraded: false, ambiguity: 0,
      stats: { elementsScanned: 0, candidates: 0, visible: 0, emitted: 0, shadowRoots: 0, emptyName: 0, modalScoped: false, ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 } },
      items: [],
    };
    const offered = [false, true].flatMap((final) =>
      guideAgent
        .outputSchema({ goal: 'g', table, history: { done: [], route: [] }, ...(final ? { final: true as const } : {}) })
        .map((t) => t.name),
    );
    expect(offered.length, '模型看到的工具：一个都没有——守卫在空集上恒真').toBeGreaterThan(0);

    expect(intents).not.toContain('act');
    expect([...new Set([...intents, ...offered])].filter((n) => actingWords(n).length > 0)).toEqual([]);
  });

  /**
   * The second lock. Even with an `act` registered, the host could do nothing
   * with it unless the content script had a verb that acts — the host's only
   * way into the page is `RPC_TYPES`. The closed list above forces a visible
   * diff for every new verb; this one refuses any verb whose name says it
   * acts, however it is spelled. `WAIT_FOR` and `WAITING_FOR_PANEL` pass on
   * their own words: one reads the page until a text appears or goes, the
   * other writes one line on our own overlay.
   */
  it('RPC 动词里没有执行动词：按动词名里的词判，不按一份名单', async () => {
    const { RPC_TYPES } = await import('@/shared/protocol');
    expect(RPC_TYPES.length, 'RPC 动词：一个都没有——守卫在空集上恒真').toBeGreaterThan(0);
    expect(RPC_TYPES.filter((v) => actingWords(v).length > 0)).toEqual([]);
  });

  it('只有 transport 与 fetchDoc 执行器可以发起网络请求', () => {
    // Narrowed from "nothing may" when P-03 arrived, widened from a single
    // exception to two when the effect protocol's `fetchDoc` executor landed
    // (design doc §11.1: "「只有 provider 层可发网络请求」拆成四条:两个 fetch
    // 点白名单"), and narrowed again from "the provider layer" to the one file
    // in it that sends: `provider.ts` now describes a wire format and nothing
    // more, so it is in scope here like everything else. The point was never
    // the absence of network code — it was that the *API key* has exactly one
    // destination, and a layer with room for two files has room for two keys.
    // `sidepanel/effects.ts`'s fetch call never sees `cfg.apiKey` (its
    // `fetchFn` parameter takes a bare `url`, `runFetchDocEffect` has no
    // `ProviderConfig` in scope at all), so admitting it here does not widen
    // where the key can travel — the two checks below are what keep that true
    // instead of assumed.
    const SECOND_FETCH_POINT = join('entrypoints', 'sidepanel', 'effects.ts');
    const rest = scope(
      'transport 与 fetchDoc 之外的源码',
      (f) => !f.includes('tests') && !f.endsWith(join('agent', 'provider', 'transport.ts')) && !f.endsWith(SECOND_FETCH_POINT),
    );
    expect(offending(rest, detect.network)).toEqual([]);
    alive('网络请求', detect.network);

    // The second point itself: real, callable (not just dodging the check
    // above by parameter name), anonymous, and never in possession of a key.
    const effects = factsOf(join(SRC, SECOND_FETCH_POINT));
    expect(effects.calls.some((c) => c.chain === 'fetchFn')).toBe(true);
    expect([...effects.names, ...effects.strings].filter((w) => /apiKey|Authorization/.test(w))).toEqual([]);
    expect(effects.properties.some((p) => p.name === 'credentials' && p.value === 'omit')).toBe(true);
  });

  it('content script 不得触碰扩展存储（密钥隔离）', () => {
    // The content script shares a process with the page. Anything it can read,
    // a page bug can eventually reach — so it must never be able to read the
    // key at all, rather than merely choosing not to.
    const pageSide = scope(
      '页面侧',
      (f) => f.endsWith(join('entrypoints', 'content.ts')) || f.includes(join('core', 'extractor')) || f.includes(join('core', 'overlay')),
    );
    expect(offending(pageSide, detect.extensionStorage)).toEqual([]);
    alive('扩展存储', detect.extensionStorage);
  });

  it('注进页面框架里的那段探针只许看尺寸：不碰 chrome.*，不碰存储，不碰密钥', () => {
    // `enterFrames` 把一个函数注进这一页的**每一个**框架里，包括广告和跟踪器。
    // 它跑在那些文档的隔离世界里，拿得到的东西和内容脚本一样多——而内容脚本那条
    // 「不许碰扩展存储」的红线（上一条）按文件划范围，划不到这一段内联函数上。
    //
    // 所以这里按文本盯住它本身：它今天只读地址、视口尺寸和控件个数，明天想往里
    // 加别的，先得过这一关。
    const src = readFileSync(join(SRC, 'shared', 'rpc.ts'), 'utf8');
    const at = src.indexOf('func: () =>');
    expect(at, '`enterFrames` 里那段探针不见了或改了写法：这条守卫要跟着改，否则它什么都不守').toBeGreaterThan(-1);
    const probe = src.slice(at, src.indexOf('}),', at));
    for (const forbidden of ['chrome.', 'storage', 'apiKey', 'fetch(', 'postMessage'])
      expect(probe.includes(forbidden), `探针里出现了 ${forbidden}`).toBe(false);
    // 反向：它确实还在看它该看的东西（守卫不能因为探针被掏空而变成恒真）。
    for (const expected of ['location.href', 'innerWidth', 'querySelectorAll'])
      expect(probe.includes(expected), `探针不再读 ${expected}：这条守卫的对象变了`).toBe(true);
  });

  it('API Key 不得进入日志或事件流', () => {
    // storage.sync would replicate the key to Google's servers, which is the
    // exact opposite of what the UI tells the user.
    expect(offending(scope('设置', (f) => f.endsWith(join('shared', 'settings.ts'))), detect.syncStorage)).toEqual([]);
    // Only `settings.ts` is exempt now. `provider.ts` used to be, because it
    // was the file that held the key; `transport.ts` holds it today and asks
    // for no exemption — the rule is "a key never goes near a log", and
    // nothing that carries one has ever needed to break it.
    const rest = scope('设置之外的源码', (f) => !f.includes('tests') && !f.endsWith('settings.ts'));
    expect(offending(rest, detect.keyNearLogs)).toEqual([]);
    // Neither fires anywhere in the tree; both are proven on synthetic violations below.
  });

  it('N-3:页面侧代码不得改用户选区（那属于「开车」）', () => {
    const pageSide = scope('页面侧', (f) => f.includes(join('core', 'overlay')) || f.endsWith(join('entrypoints', 'content.ts')));
    expect(offending(pageSide, detect.selection)).toEqual([]);
  });

  it('N-4:只有宿主可以指挥 content script', () => {
    // Not just the wrapper name: `chrome.tabs.sendMessage` reaches the content
    // script exactly the same way `sendToTab` does, and is what Task 6 removed
    // from the side panel — a bare name-check would not stop it growing back.
    const rest = scope(
      '宿主与 rpc 之外的源码',
      (f) => !f.endsWith(join('entrypoints', 'background.ts')) && !f.endsWith(join('shared', 'rpc.ts')),
    );
    expect(offending(rest, detect.commandsContent)).toEqual([]);
    alive('指挥 content script', detect.commandsContent);
  });

  it('N-5:core 不得依赖 agent（依赖方向单向）', () => {
    // Every spelling of the import counts — the `@/agent/` alias, a relative
    // path (`../agent/`, `../../agent/`, …, exactly what autocomplete offers
    // from inside `core/`), a re-export, or a dynamic `import()`.
    expect(offending(scope('core', (f) => f.includes(join('src', 'core'))), detect.importsAgent)).toEqual([]);
    alive('依赖 agent', detect.importsAgent);
  });

  it('N-6:侧栏不拥有流程状态', () => {
    // No session storage at all, and no flow key spelled out — `guide:` and
    // `effect:` are the host's, and `thread:` is the retired one.
    expect(offending(scope('侧栏', (f) => f.includes(join('entrypoints', 'sidepanel'))), detect.flowState)).toEqual([]);
    alive('流程状态', detect.flowState);
  });

  it('N-1:agent 层不得出现 chrome.*(平台无关,才能在 node 里单测、才能换宿主)', () => {
    // Any `chrome` name counts — `const c = chrome;` aliases the global and
    // never spells `chrome.` again. A string such as `chrome-extension://` is
    // a string in the tree, not a name, so it needs no special case.
    expect(offending(scope('agent', (f) => f.includes(join('src', 'agent'))), detect.chrome)).toEqual([]);
    alive('chrome', detect.chrome);
  });

  it('N-2:归约器在运行时能加载到的每一个文件都不得出现 await / fetch( / chrome.（手写状态机能被信任的唯一理由）', () => {
    // This is what lets `step` be trusted to run in node, be replayed
    // deterministically from a persisted `ThreadState`, and survive the service
    // worker being evicted mid-flight.
    //
    // Held over everything the reducer loads, not over one file name. The
    // pieces its branches share already live next door, and the Output and
    // Tool modules carry consequences of their own; a rule keyed to one path
    // stops guarding the moment code moves out of it.
    const reducer = join(SRC, 'agent', 'thread', 'machine.ts');
    // Self-check: reaching the reducer and the pieces it is built from is the
    // least the closure can do — anything less and it has stopped following
    // imports, which would pass every rule below by checking nothing. It also
    // reaches past `src/agent`: a `core/` file the reducer loads replays or
    // fails to replay exactly as the reducer does.
    expect(importClosure(reducer).map(rel)).toEqual(
      expect.arrayContaining([
        rel(reducer),
        rel(join(SRC, 'agent', 'thread', 'transitions.ts')),
        rel(join(SRC, 'agent', 'tools', 'read-doc.ts')),
        // 纯文本模块，归约器渲染失败那句话时用它——闭包里出现它是对的，
        // 它没有任何 import，所以 N-2 照旧成立。
        rel(join(SRC, 'agent', 'provider', 'advice.ts')),
        rel(join(SRC, 'agent', 'agents', 'guide', 'output', 'point.ts')),
        rel(join(SRC, 'agent', 'agents', 'guide', 'output', 'done.ts')),
        rel(join(SRC, 'agent', 'agents', 'guide', 'output', 'ask.ts')),
      ]),
    );
    expect(purityOffenders(reducer).map((o) => `${rel(o.file)} :: ${o.rules.join(', ')}`), 'N-2 违例').toEqual([]);
    for (const rule of N2_RULES) alive(`N-2 ${rule.name}`, rule.hit);
  });

  it('归约器不知道 Plugin：skills 目录下的任何文件与收集 Plugin 贡献的模块都不在它的依赖闭包里', () => {
    // Collected on the host when a call is sent (`agent/context/plugins.ts`),
    // because which Plugins are on is a storage read and the reducer reads
    // nothing. A reducer that reached one would also start deciding what a
    // thread is told from something that is not in its state.
    //
    // The skills by directory: each skill is its own file, and a reducer that
    // imported one directly would reach it without passing the registry. The
    // collector by file: `context/` is also where the rest of the Context
    // assembly is headed (spec A's target tree), which this guard is not about.
    const closure = importClosure(join(SRC, 'agent', 'thread', 'machine.ts')).map(rel);
    const skills = join(SRC, 'agent', 'skills');
    const collector = join(SRC, 'agent', 'context', 'plugins.ts');
    for (const f of [skills, collector]) expect(existsSync(f), `${rel(f)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
    expect(closure.filter((f) => f === rel(collector) || f.startsWith(`${rel(skills)}/`))).toEqual([]);
  });

  it('解析、校验、提示词这层共用的机器不得加载 agent 的登记处', () => {
    // Every intent module imports the contract. If the shared layer loaded the
    // registry — or the intent list read off it — a module importing the
    // contract would close an import cycle, and the shared layer would stop
    // being machinery the agent uses. The agent hands the contract what it
    // knows instead.
    const agentOwned = [join(SRC, 'agent', 'agents', 'guide', 'registry.ts'), join(SRC, 'agent', 'intents.ts')];
    for (const f of agentOwned) expect(existsSync(f), `${rel(f)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
    for (const shared of ['envelope/contract.ts', 'envelope/validate.ts', 'prompts/system.ts', 'context/user-message.ts']) {
      const closure = importClosure(join(SRC, 'agent', shared)).map(rel);
      for (const f of agentOwned) expect(closure, shared).not.toContain(rel(f));
    }
  });

  it('agent 下的每个目录名在词汇表里都有词条', () => {
    // Reading a directory name should be enough to look it up. Written out
    // rather than derived from the name: a new directory has to be entered
    // here, which is the moment to ask what term it stands for.
    const TERM_OF: Record<string, string> = {
      agents: 'Agent', guide: 'Guide', output: 'Output', tools: 'Tool', envelope: 'Envelope',
      prompts: 'Prompt', context: 'Context', skills: 'Skill', thread: 'Thread', provider: 'Provider',
      conversation: 'Conversation', protocols: 'Protocol',
    };
    const glossary = read(join(process.cwd(), 'CONTEXT.md'));
    const dirs: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) {
          dirs.push(p);
          walk(p);
        }
      }
    };
    walk(join(SRC, 'agent'));
    expect(dirs.length, '一个目录都没扫到——判据已经不在守了').toBeGreaterThan(0);
    expect(dirs.filter((d) => !(basename(d) in TERM_OF)).map(rel), '新目录：先在上面写明它对应哪个词条').toEqual([]);
    expect(dirs.filter((d) => !glossary.includes(`**${TERM_OF[basename(d)]}**：`)).map((d) => `${rel(d)} → ${TERM_OF[basename(d)]}`)).toEqual([]);
  });

  it('「同一个视图」的判定是叶子文件：零 import', () => {
    // Every judgement of View reads this one definition; a leaf is what lets
    // the reducer, the guide module, the host and the extractor all use it
    // without one of them dragging the others in.
    const view = join(SRC, 'shared', 'view.ts');
    expect(existsSync(view), `${rel(view)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
    expect(factsOf(view).imports).toEqual([]);
  });

  it('评测指纹够不着 provider 层：再加一个协议，它也不会动', () => {
    // 指纹回答的是「模型读到的东西变没变」，而 `{system, user, tools}` 三段是
    // 协议无关的。它从前哈希整个请求，于是「怎么发」一变它就变——一句关于提示词
    // 的假话，外加所有历史 run 的可比性一次性作废。够不着的东西动不了它：这里
    // 按运行时闭包查（`import type` 会被擦掉，擦掉的东西改不了一个哈希值）。
    const fp = join(process.cwd(), 'evals', 'fingerprint.ts');
    const rendered = join(process.cwd(), 'evals', 'rendered.ts');
    for (const f of [fp, rendered]) expect(existsSync(f), `${rel(f)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
    const providerDir = rel(join(SRC, 'agent', 'provider'));
    for (const entry of [fp, rendered]) {
      const closure = importClosure(entry).map(rel);
      expect(closure.length, `${rel(entry)}：闭包只有它自己，判据没在跟 import`).toBeGreaterThan(1);
      expect(closure.filter((f) => f.startsWith(`${providerDir}/`)), rel(entry)).toEqual([]);
    }
  });

  it('评估的统计是纯函数：evals/stats.ts 零 import（因此零 I/O、不依赖产品代码）', () => {
    // Its tests check it against numbers computed independently from runs six
    // and seven. An import is a way for something else to move those numbers.
    const stats = join(process.cwd(), 'evals', 'stats.ts');
    expect(existsSync(stats), `${rel(stats)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
    expect(factsOf(stats).imports).toEqual([]);
  });

  it('路标、到达期望与 Trace 住在零 import 的类型文件里；线上协议与共享层连类型在内都够不着任何一个 agent', () => {
    // The Thread, the wire messages and the Run record carry these types. Held
    // by the guide agent, they tied the wire protocol to it in a type cycle —
    // directly through the guide Output module, and around through the trace,
    // whose run loop reaches that module again. Types count here: the cycle
    // was made of nothing else.
    const types = join(SRC, 'shared', 'types.ts');
    for (const name of ['GuideRouteHop', 'GuideExpectAfter', 'Trace']) expect(read(types)).toMatch(new RegExp(`export interface ${name}\\b`));
    expect(factsOf(types).imports).toEqual([]);
    const agents = rel(join(SRC, 'agent', 'agents'));
    const sharedLayer = scope('线上协议与共享层', (f) => f.includes(join('src', 'shared')) || f.includes(join('agent', 'envelope')));
    const reaching = sharedLayer.flatMap((f) =>
      importClosure(f, undefined, { types: true }).map(rel).filter((c) => c.startsWith(`${agents}/`)).map((c) => `${rel(f)} → ${c}`),
    );
    expect(reaching).toEqual([]);
  });

  it('单写者链：归约器的 step 只有 agent/thread/writer.ts 一个调用者', () => {
    // The danger is not a defect `step` itself could exhibit (it is a pure
    // function and cannot refuse a caller) — it is a second process running the
    // same reducer to "optimistically" predict a cursor move (design doc §2.4).
    const callers = files.filter((f) => callsReducerStep(read(f))).map((f) => f.slice(SRC.length + 1));
    // Self-check first. An empty set used to pass — and did, for as long as the
    // old pattern matched no real import at all.
    expect(callers.length, '判据在当前源码上一处都没匹配到——它已经不在守了').toBeGreaterThan(0);
    expect(callers).toEqual([join('agent', 'thread', 'writer.ts')]);
    // A re-export is a second door: whoever imports from it can call `step` without naming the reducer.
    expect(files.filter((f) => reexportsReducerStep(read(f))).map(rel)).toEqual([]);
  });

  it('宿主不得依赖运行循环 guide/runner.ts（决策与执行的分界没有因为同住一个目录而消失）', () => {
    // `guide/agent.ts` (pure) and `guide/runner.ts` (one of the two files
    // under `src/agent` that open a socket) are neighbours now, and that adjacency
    // is exactly what makes this guard necessary: an import away from
    // `machine.ts` sits a `complete()` call, and the reducer's whole claim —
    // that a persisted `ThreadState` replays deterministically in a plain node
    // test — dies the moment one lands. N-2 would catch a literal `fetch(`
    // typed into `machine.ts`; it would not catch a `runGuide` import that
    // reaches the network two files later.
    //
    // The panel is where the runner belongs (CONTEXT.md `Panel`: a service worker is
    // killed at 30s, so the SSE request cannot live in the SW at all).
    expect(scope('宿主', (f) => f.includes(join('agent', 'thread'))).filter((f) => importsRunner(read(f))).map(rel)).toEqual([]);
    alive('依赖 runner', detect.runner);
  });

  it('evals/ 不依赖 tests/ 下的任何文件（tests/ 不进版本管理，evals/ 进）', () => {
    // `.gitignore` drops the whole of `tests/`. An eval that imports or reads a
    // file from there runs on this machine and nowhere else — and the
    // annotations, verdicts and corpus under `evals/` are versioned precisely so
    // they can be run again somewhere else. Two ways in: an import, and a path
    // read at runtime (`path.join(REPO, 'tests/…')`).
    const ROOT = process.cwd();
    const TESTS = join(ROOT, 'tests') + '/';
    const walkAll = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walkAll(p) : /\.(ts|mjs)$/.test(p) ? [p] : [];
      });
    const reachesTests = (f: Facts, from: string) =>
      f.imports.some((i) => i.module.startsWith('.') && join(from, '..', i.module).startsWith(TESTS)) ||
      f.strings.some((s) => /(^|[^\w.-])tests\//.test(s));

    const evalFiles = walkAll(join(ROOT, 'evals'));
    expect(evalFiles.length, 'evals/ 下一个脚本都没扫到——守卫在空集上恒真').toBeGreaterThan(0);
    expect(evalFiles.filter((f) => reachesTests(factsOf(f), f)).map(rel)).toEqual([]);

    const scripts = JSON.parse(read(join(ROOT, 'package.json'))).scripts as Record<string, string>;
    const evalScripts = Object.entries(scripts).filter(([k]) => k === 'eval' || k.startsWith('eval:'));
    expect(evalScripts.length, 'package.json 里一条 eval 命令都没有——守卫在空集上恒真').toBeGreaterThan(0);
    expect(evalScripts.filter(([, cmd]) => /(^|[\s/])tests\//.test(cmd)).map(([k]) => k)).toEqual([]);

    // The detector fires on both ways in, and not on a sibling inside evals/.
    const probe = join(ROOT, 'evals', 'task', 'probe.mjs');
    expect(reachesTests(factsOfText("import x from '../../tests/unit/fixtures/flag-store';", probe), probe)).toBe(true);
    expect(reachesTests(factsOfText("fs.readFileSync(path.join(REPO, 'tests/eval/captured/a.json'));", probe), probe)).toBe(true);
    expect(reachesTests(factsOfText("import x from '../extract/score.mjs';", probe), probe)).toBe(false);
  });

  it('每个协议的请求体字段都落在它自己那张白名单内（这就是这次重构的理由）', () => {
    // 换掉自定义文本契约、改用工具调用，图的就是「换个模型还能跑」。一个端点
    // 专有的字段会悄悄把这句话变成假话：多数兼容层对不认识的字段是**静默忽略**
    // 而不是报错（实测 DeepSeek 连 `__definitely_not_a_field` 都回 200），所以
    // 线上不会有任何症状，只会在别家少一个能力。多协议之后这个风险变大而不是
    // 变小，所以白名单一协议一张，而不是所有人跟着 OpenAI 的名单走。
    //
    // 每张名单按那个协议的一手文档来。`strict` 写在 tools[].function 里，
    // Anthropic 明确忽略、DeepSeek 标 beta——发得，但不能指望。要加新字段，先查
    // 一手文档，再往这里加一行。
    //
    // 预设自己要求的字段（`Preset.request`）是唯一的例外：它只发给这个预设的
    // 端点，所以不按协议查，而是按那一家查。展开写法一改，`spread` 就对不上，
    // 逼人回来重看——**不要绕过它**，改这里的常量。
    const PRESET_FIELDS: Record<string, string[]> = {
      // api-docs.deepseek.com 思考模式指南：默认开思考，`thinking: {type}` 开关。
      // 实测 2026-09-14，deepseek-flash：开思考 + tool_choice required → 400；
      // thinking disabled → 200 且调用了工具。
      deepseek: ['thinking'],
      // 通义的思考模式同样拒收 `tool_choice: required`，开关名却不一样——
      // DashScope 的 OpenAI 兼容模式用 `enable_thinking`。实测 2026-09-25，
      // qwen3.8-max：带 required → 400「The tool_choice parameter does not
      // support being set to required or object in thinking mode」；加
      // `enable_thinking: false` → 200 且调用了工具。DeepSeek 那条拼法
      // （`thinking: {type:'disabled'}`）发给它反而 400，所以两家不能合成一个字段。
      // 也试过发给本预设的另一个模型：qwen-max 带上它照样 200。
      dashscope: ['enable_thinking'],
    };
    const OPENAI_CHAT = ['model', 'messages', 'stream', 'stream_options', 'temperature', 'tools', 'tool_choice', 'parallel_tool_calls'];
    // 两张名单不一样，这正是「一协议一张」的理由：Responses 的对话字段叫
    // `input` 不叫 `messages`，而且它不需要 `stream_options`——用量本来就在
    // `response.completed` 上，没有东西可开。
    const OPENAI_RESPONSES = ['model', 'input', 'stream', 'temperature', 'tools', 'tool_choice', 'parallel_tool_calls'];
    const SENDERS: { file: string; allowed: string[]; spread: string }[] = [
      {
        file: join(SRC, 'agent/provider/protocols/openai-chat.ts'),
        allowed: OPENAI_CHAT,
        spread: "…request.providerOptions?.['openai-chat']",
      },
      {
        file: join(SRC, 'agent/provider/protocols/openai-responses.ts'),
        allowed: OPENAI_RESPONSES,
        spread: "…request.providerOptions?.['openai-responses']",
      },
    ];

    for (const { file, allowed, spread } of SENDERS) {
      expect(existsSync(file), `${rel(file)} 换了位置：这条守卫要跟着改，否则它什么都不守`).toBe(true);
      const keys = requestBodyKeys(read(file));
      expect(keys.length, `${rel(file)}：没解析出任何字段，说明这条判据本身失效了`).toBeGreaterThan(3);
      expect(keys.filter((k) => !allowed.includes(k) && k !== spread), rel(file)).toEqual([]);
      expect(keys, `${rel(file)}：预设字段的展开不见了：要么删掉 Preset.request，要么更新这里`).toContain(spread);
    }

    // 每一个适配器都要有自己的一张：新增一个协议而忘了立名单，这里会红。
    const adapters = readdirSync(PROTOCOLS_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => join(PROTOCOLS_DIR, f));
    expect(adapters.length, '适配器目录下一个协议都没有——守卫在空集上恒真').toBeGreaterThan(0);
    expect(adapters.filter((f) => !SENDERS.some((s) => s.file === f)).map(rel), '这个协议没有自己的请求体白名单').toEqual([]);

    for (const p of PRESETS) expect(Object.keys(p.request ?? {}), `预设 ${p.id}`).toEqual(PRESET_FIELDS[p.id] ?? []);
  });

  it('适配器目录里不得出现 fetch，也不得出现密钥的任何拼法', () => {
    // 「API Key 只有一个去处」是拒绝第三方 provider SDK 的第一条理由——那些包
    // 每一个都自己 fetch，于是每一个都摸到用户的密钥。在自己这边把持有者从 1
    // 个变成 1+N 个，等于把最想守的那条线白送掉。所以适配器只声明
    // `auth: 'bearer'`，贴头的动作留在 transport 里。
    const adapters = scope('适配器', (f) => f.includes(join('provider', 'protocols')));
    expect(offending(adapters, detect.network)).toEqual([]);
    // And pure while we are here: both halves are functions a test can assert
    // on directly, with no fake `fetch` and no fake `Response`, and that stays
    // true only while there is no I/O, no clock and no platform under them.
    //
    // Not the reducer's rule, though: N-2 also forbids `await`, because a
    // persisted `ThreadState` has to replay synchronously. `parse` reads a
    // stream — `for await` is how it is spelled, not a side effect — so the
    // three that apply here are the socket, the platform, and anything that
    // would make the same input give a different answer twice.
    expect(offending(adapters, detect.chrome)).toEqual([]);
    expect(offending(adapters, detect.impure)).toEqual([]);
    alive('钟 / 随机 / 环境', detect.impure);
    const KEY_WORDS = /^(apiKey|Authorization|x-api-key)$/i;
    const leaks = adapters.flatMap((f) => {
      const facts = factsOf(f);
      return [...facts.names, ...facts.strings, ...facts.accesses.map(lastSegment)].filter((w) => KEY_WORDS.test(w)).map((w) => `${rel(f)} :: ${w}`);
    });
    expect(leaks).toEqual([]);
  });

  it('provider 层不得依赖 core/（依赖方向不能反过来）', () => {
    // The provider layer is the key and the socket — it knows `ChatMessage[]`
    // and HTTP, nothing about `UINode` or `PromptTable`. Should this dependency
    // direction ever flip, swapping the host that runs it (an offscreen
    // document, some other process) stops being "swap one effect interpreter"
    // and becomes untangling a page-side import from a network-only file. Held
    // over the whole directory rather than one file: splitting `transport.ts`
    // out of `provider.ts` must not be a way for the rule to stop applying to
    // half of what it used to cover. A bare side-effect `import '@/core/…'`
    // counts too.
    expect(offending(scope('provider', (f) => f.includes(join('agent', 'provider'))), detect.importsCore)).toEqual([]);
    alive('依赖 core', detect.importsCore);
  });

  it('效果协议：EFFECT_REQUEST/EFFECT_RESULT 的收发逻辑不在 src/agent 下', () => {
    // N-1's shape for this task: the two message *envelopes* (with their
    // `type` tag and any chrome-facing send/receive code) belong to
    // `entrypoints`/`sidepanel`. `src/agent/thread/effect.ts` only defines the
    // untagged `EffectRequest`/`EffectResult` *data* shapes — neither tag
    // ever needs to appear there, or anywhere else under `src/agent`.
    expect(offending(scope('agent', (f) => f.includes(join('src', 'agent'))), detect.effectTags)).toEqual([]);
    alive('效果协议标签', detect.effectTags);
  });

  it('宿主不拿消息的来路当 panel 的身份（真侧栏没有 documentId）', () => {
    // The real side panel — the surface this product is actually used through
    // — sends messages with no `documentId`, no `frameId` and no `tab`. A host
    // that identified panels that way granted no claim to it at all, so every
    // model call sat unclaimed and the panel showed 「正在想」 forever, while
    // the pull that was supposed to recover it re-dispatched 320 times a
    // second. A panel says its own name (`EFFECT_CLAIM.panelId`); whether it
    // is still there is the port's to answer (`PANEL_PORT`).
    expect(offending(scope('宿主', (f) => f.includes(join('entrypoints', 'background.ts'))), detect.senderIdentity)).toEqual([]);
  });

  it('效果协议（收口后）：effects.ts 只在两处调用 sendMessage（EFFECT_CLAIM 仲裁与回传 EFFECT_RESULT）', () => {
    // Was "只在一处" until the same-tab multi-instance gap (once accepted as
    // known) turned out to have a cheap fix: an `EFFECT_CLAIM` round trip
    // *before* `complete()`/`fetch()`, so the host can arbitrate which of
    // possibly several same-tab panel instances actually runs a dispatched
    // effect. That is a second, deliberate call site — a *third* would be a
    // second place the panel could independently decide to talk to the host
    // about a model call, which is exactly the kind of duplicate authority this
    // guard exists to keep at zero.
    const effects = factsOf(join(SRC, 'entrypoints', 'sidepanel', 'effects.ts'));
    expect(effects.calls.filter((c) => lastSegment(c.chain) === 'sendMessage')).toHaveLength(2);
    for (const tag of ['EFFECT_CLAIM', 'EFFECT_RESULT'])
      expect(effects.properties.some((p) => p.name === 'type' && p.value === tag), tag).toBe(true);
  });
});

/**
 * 反向验证（08）：证明上面那些守卫真的会开火。
 *
 * 一条永远绿的守卫和一条不存在的守卫，从 CI 看是同一回事。这里把每个判据喂给
 * 一段**已知违例**的合成源码，断言它被抓住——这样「守卫失效」本身也会变红，而
 * 不是悄悄地不再拦任何东西。
 *
 * 用合成源码而不是真去改文件：这一程里我两次为了做变异检验写坏了已提交的
 * 语料文件，其中一次差点没发现。判据问的是语法树，喂给它一段源码就够了。
 */
describe('架构守卫的反向验证：每一条都要能抓到已知违例', () => {
  const on = (src: string) => factsOfText(src);

  it('「不拿来路当身份」抓得住 sender.documentId 与按 documentIds 查上下文', () => {
    expect(detect.senderIdentity(on('const who = sender.documentId;'))).toBe(true);
    expect(detect.senderIdentity(on('await chrome.runtime.getContexts({ documentIds: [id] });'))).toBe(true);
    // 按 panel 自己报的名字认人，才是现在的写法
    expect(detect.senderIdentity(on('const granted = await claim(threadId, effectId, panelId);'))).toBe(false);
  });

  it('N-2 的三条判据分别抓得住 await / fetch( / chrome.', () => {
    const [awaits, fetches, chrome] = N2_RULES;
    expect(awaits!.hit(on('const x = await load();'))).toBe(true);
    expect(fetches!.hit(on('return fetch("https://x");'))).toBe(true);
    expect(chrome!.hit(on('chrome.storage.session.get(k)'))).toBe(true);
    // 而正常的 reducer 代码不该被误伤
    expect(N2_RULES.some((r) => r.hit(on('const next = { ...state, cursor: state.cursor + 1 };')))).toBe(false);
    // `chrome-mv3` 这类连字符串是字符串，不是 `chrome` 这个名字
    expect(chrome!.hit(on('const dir = "dist/chrome-mv3";'))).toBe(false);
  });

  it('N-2 的范围按依赖闭包：违例藏在第二层也抓得住；import type 不算，import { type X } 算', () => {
    const at = (p: string) => join(SRC, 'agent', 'thread', p);
    const tree = new Map<string, string>([
      [
        at('machine.ts'),
        "import { present } from './transitions';\nimport type { T } from './erased';\nimport { type U } from './kept';\nexport const step = () => present();",
      ],
      [at('transitions.ts'), "import { load } from '@/agent/thread/io';\nexport const present = () => load;"],
      [at('io.ts'), 'export const load = async () => await fetch("https://x");'],
      [at('kept.ts'), 'export type U = 1;\nexport const peek = () => chrome.storage.session.get("k");'],
      [at('erased.ts'), 'export type T = 1;\nexport const never = async () => await fetch("y");'],
    ]);
    const read = (p: string) => tree.get(p);
    expect([...importClosure(at('machine.ts'), read)].sort()).toEqual(
      [at('io.ts'), at('kept.ts'), at('machine.ts'), at('transitions.ts')].sort(),
    );
    const found = purityOffenders(at('machine.ts'), read).sort((a, b) => a.file.localeCompare(b.file));
    expect(found).toEqual([
      { file: at('io.ts'), rules: ['await', 'fetch('] },
      { file: at('kept.ts'), rules: ['chrome'] },
    ]);
  });

  it('依赖闭包认得 WXT 的四个别名、.js 后缀、index.tsx；指向源码树却找不到的 import 直接报错', () => {
    const root = process.cwd();
    const src = (p: string) => join(SRC, p);
    const tree = new Map<string, string>([
      [src('entry.ts'), ["import '~/a';", "import '@@/scripts/b';", "import '~~/scripts/c';", "import './d.js';", "import './e';"].join('\n')],
      [src('a.ts'), ''],
      [join(root, 'scripts', 'b.ts'), ''],
      [join(root, 'scripts', 'c.ts'), ''],
      [src('d.ts'), ''],
      [src(join('e', 'index.tsx')), ''],
    ]);
    const read = (p: string) => tree.get(p);
    expect([...importClosure(src('entry.ts'), read)].sort()).toEqual([...tree.keys()].sort());
    // Silently dropping this would let the closure stop short and pass.
    tree.set(src('entry.ts'), "import './gone';");
    expect(() => importClosure(src('entry.ts'), read)).toThrow('找不到对应的文件');
    // A package is not this tree's business, and not an error either.
    tree.set(src('entry.ts'), "import ts from 'typescript';\nimport '@scope/pkg';");
    expect(importClosure(src('entry.ts'), read)).toEqual([src('entry.ts')]);
  });

  it('协议白名单判据抓得住一个端点专有字段', () => {
    // 正向断言全绿，所以这条反向验证不是形式主义：它证明的是「如果有人加了
    // 一个不该加的字段，上面那条真的会红」，而不是「上面那条恰好扫不到东西」。
    const ALLOWED = new Set(['model', 'messages', 'stream', 'temperature']);
    const fake = [
      'const init = {',
      '  body: JSON.stringify({',
      '    model: cfg.model,',
      '    messages,',
      '    stream: true,',
      '    reasoning_content: true,',
      '  }),',
      '};',
    ].join('\n');
    const keys = requestBodyKeys(fake);
    expect(keys).toContain('reasoning_content');
    expect(keys.filter((k) => !ALLOWED.has(k))).toEqual(['reasoning_content']);
    // A key hidden in a conditional spread is still a key the endpoint receives.
    expect(requestBodyKeys('const i = { body: JSON.stringify({ model, ...(on ? { tools, secret_field: 1 } : {}) }) };')).toEqual(['model', 'tools', 'secret_field']);
    // A spread of something the source does not spell out cannot be checked, so it is reported rather than skipped.
    expect(requestBodyKeys('const i = { body: JSON.stringify({ model, ...extra }) };').some((k) => k.startsWith('…'))).toBe(true);
  });

  it('宿主-runner 判据抓得住三种 import 写法，且不误伤同目录的纯 agent.ts', () => {
    expect(importsRunner("import { runGuide } from '@/agent/agents/guide/runner';")).toBe(true);
    expect(importsRunner("import { runGuide } from '../guide/runner';")).toBe(true);
    expect(importsRunner("import { runGuide } from './runner';")).toBe(true);
    // A regex over text saw neither of these.
    expect(importsRunner("const m = await import('@/agent/agents/guide/runner');")).toBe(true);
    expect(importsRunner("export { runGuide } from '../guide/runner';")).toBe(true);
    // 宿主 *应该* 依赖纯的那一半——这正是门面存在的理由，不能被一并拦下。
    expect(importsRunner("import { guideAgent } from '@/agent/agents/guide/agent';")).toBe(false);
  });

  it('单写者链判据看的是调用，不是 import', () => {
    expect(callsReducerStep("import { pageChange, step } from './machine';\nconst r = step(prior, input);")).toBe(true);
    expect(callsReducerStep("import { step as reduce } from '../thread/machine';\nreduce(s, i);")).toBe(true);
    expect(callsReducerStep("import * as machine from '@/agent/thread/machine';\nmachine.step(s, i);")).toBe(true);
    // Imported but never called, imported only as a type, or someone else's `step`: not a writer.
    expect(callsReducerStep("import { step } from './machine';\nexport type S = typeof step;")).toBe(false);
    expect(callsReducerStep("import type { step } from './machine';")).toBe(false);
    expect(callsReducerStep("import { type MachineEffect } from './machine';\nstep(a, b);")).toBe(false);
    expect(callsReducerStep("import { step } from './thread';\nstep(a, b);")).toBe(false);
    // And a second door is seen for what it is.
    expect(reexportsReducerStep("export { step } from './machine';")).toBe(true);
    expect(reexportsReducerStep("export * from '@/agent/thread/machine';")).toBe(true);
    expect(reexportsReducerStep("export { pageChange } from './machine';")).toBe(false);
  });

  it('单写者链：把 step 的第二个调用点加进另一个模块，判据就会变红', () => {
    const writer = read(join(SRC, 'agent', 'thread', 'writer.ts'));
    const second = "import { step } from '@/agent/thread/machine';\nexport const predict = (s, i) => step(s, i);";
    expect([writer, second].filter(callsReducerStep)).toHaveLength(2);
  });

  it('「不得操作页面」判据抓得住每一种让页面替用户动作的写法', () => {
    const acts = (src: string) => ACTING_RULES.some((r) => r.hit(on(src)));
    for (const violator of [
      'el.click()',
      'input.blur()',
      'form.submit()',
      'el.dispatchEvent(ev)',
      'new KeyboardEvent("keydown")',
      'document.execCommand("copy")',
      'input.select()',
      'input.setSelectionRange(0, 1)',
      'document.designMode = "on"',
    ])
      expect(acts(violator), `没抓住：${violator}`).toBe(true);
    // focus() 有自己更窄的守卫，不在这条名单里——聚焦不是激活
    expect(acts('el.focus({ preventScroll: true })')).toBe(false);
    // Every rule, not just the list as a whole, has to be able to fire.
    const fired = ACTING_RULES.filter((r) =>
      ['el.click()', 'input.blur()', 'form.submit()', 'el.dispatchEvent(ev)', 'new KeyboardEvent("k")', 'document.execCommand("c")', 'input.select()', 'input.setSelectionRange(0, 1)', 'document.designMode = "on"'].some((v) => r.hit(on(v))),
    );
    expect(fired).toHaveLength(ACTING_RULES.length);
  });

  it('「替用户动手」的词判据：换了说法的动作都抓得住，现有的每个工具和动词都不误伤', async () => {
    for (const violator of ['act', 'CLICK', 'FILL_INPUT', 'execute_script', 'NAVIGATE_TO', 'type_text', 'press_key', 'submitForm', 'scrollIntoView'])
      expect(actingWords(violator).length, `没抓住：${violator}`).toBeGreaterThan(0);
    const { RPC_TYPES } = await import('@/shared/protocol');
    const { GUIDE_INTENT_MODULES } = await import('@/agent/agents/guide/registry');
    for (const name of [...RPC_TYPES, ...GUIDE_INTENT_MODULES.map((m) => m.intent)]) expect(actingWords(name), name).toEqual([]);
  });

  it('P-1 判据抓得住任何「猜是不是同一家」的实现', () => {
    for (const violator of ['getETLDPlusOne(host)', 'const registrable = toRegistrableDomain(h)', 'publicSuffixList.parse(h)'])
      expect(partyGuessing(on(violator)).length, `没抓住：${violator}`).toBeGreaterThan(0);
    expect(partyGuessing(on('sameHost(a, b)'))).toEqual([]);
  });

  it('「不纯」判据抓得住钟、随机与环境，且不误伤普通代码', () => {
    for (const violator of ['const t = Date.now();', 'new Date()', 'Math.random()', 'performance.now()', 'process.env.KEY'])
      expect(detect.impure(on(violator)), violator).toBe(true);
    expect(detect.impure(on('const body = JSON.stringify({ model, messages });'))).toBe(false);
    // `for await` is how a stream is read, not a side effect — the adapters
    // are allowed it where the reducer is not.
    expect(detect.impure(on('for await (const line of lines) out.push(line);'))).toBe(false);
  });

  it('树上没有真实命中点的判据，用合成违例证明它们没瞎', () => {
    expect(detect.computedStyle(on('const s = getComputedStyle(el);'))).toBe(true);
    expect(detect.computedStyle(on('window.getComputedStyle(el).display'))).toBe(true);
    expect(detect.computedStyle(on('// getComputedStyle(el) is too slow here'))).toBe(false);
    for (const violator of ['document.getSelection()', 'range.addRange(r)', 'document.execCommand("copy")'])
      expect(detect.selection(on(violator)), violator).toBe(true);
    expect(detect.syncStorage(on('chrome.storage.sync.set({ provider })'))).toBe(true);
    expect(detect.keyNearLogs(on('console.log(cfg.apiKey)'))).toBe(true);
    expect(detect.keyNearLogs(on('broadcast({ type: "X", key: cfg.apiKey })'))).toBe(true);
    expect(detect.keyNearLogs(on('const headers = { Authorization: `Bearer ${cfg.apiKey}` };'))).toBe(false);
  });
});

describe('注释里的引用必须找得到', () => {
  /**
   * Two kinds of pointer rotted the same way. Comments cited twelve plan files
   * that had been deleted long before — 89 citations of documents nobody could
   * open — and once the decision records were retired, 67 record numbers would
   * have pointed at nothing too. A comment that sends the reader to a document
   * is only worth its line if the document is there.
   */
  const REPO = process.cwd();
  const walkExt = (dir: string, re: RegExp, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walkExt(p, re, out);
      else if (re.test(p)) out.push(p);
    }
    return out;
  };
  const referencing = [SRC, join(REPO, 'tests', 'unit'), join(REPO, 'tests', 'e2e'), join(REPO, 'evals')].flatMap((d) =>
    walkExt(d, /\.(ts|tsx|mjs)$/),
  );
  const MD_REF = /(?<![\w/.-])(?:[\w.-]+\/)*[\w-]+\.md\b/g;
  // A comment can break a citation across lines — `ADR` at one line's end, the
  // number on the next — so the gap may hold whitespace and comment markers.
  const RECORD_REF = /\bADR[\s*/-]{0,12}\d{4}\b|docs\/adr\/\d{4}/g;
  const SOURCE_REF = /(?<![\w/.@-])(?:[\w.-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:tsx?|mjs)\b/g;
  const resolves = (ref: string) => existsSync(join(REPO, ref)) || existsSync(join(REPO, 'docs', ref));
  /** Comment text, as the parser sees it: a string naming some repository's licence file, or a `//` inside a
   *  URL, is not a comment. Walks token children too, so a comment alone on the line before a `}` is kept. */
  const commentsOf = (path: string): string => {
    const text = read(path);
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
    const seen = new Map<number, string>();
    const take = (ranges: ts.CommentRange[] | undefined) => ranges?.forEach((r) => seen.set(r.pos, text.slice(r.pos, r.end)));
    const visit = (n: ts.Node): void => {
      take(ts.getLeadingCommentRanges(text, n.pos));
      take(ts.getTrailingCommentRanges(text, n.end));
      n.getChildren(sf).forEach(visit);
    };
    visit(sf);
    return [...seen.values()].join('\n');
  };

  it('注释里每一处 .md 引用都指向一个真实存在的文件', () => {
    const refs = referencing.flatMap((f) => [...commentsOf(f).matchAll(MD_REF)].map((m) => ({ f, ref: m[0] })));
    // Self-check first: a detector that sees nothing proves nothing.
    expect(refs.length, '一处 .md 引用都没扫到——判据已经不在守了').toBeGreaterThan(0);
    expect(refs.filter(({ ref }) => !resolves(ref)).map(({ f, ref }) => `${rel(f)} → ${ref}`)).toEqual([]);
  });

  it('注释里点名的源码文件都还在', () => {
    // A comment naming a deleted module reads as a pointer to something that is
    // not there — one named a deleted host module for a whole ticket after it
    // was gone. A path resolves against every source file in the repository;
    // a bare file name resolves if any file has it. A leading `./` is the
    // repository root written the way a command line needs it
    // (`--import ./evals/alias-loader-register.mjs`), not part of the name.
    const known = walkExt(REPO, /\.(ts|tsx|mjs)$/).map(rel);
    const exists = (ref: string) => {
      const r = ref.replace(/^\.\//, '');
      return known.some((k) => k === r || k.endsWith(`/${r}`));
    };
    const refs = referencing.flatMap((f) => [...commentsOf(f).matchAll(SOURCE_REF)].map((m) => ({ f, ref: m[0] })));
    expect(refs.length, '一处源码文件引用都没扫到——判据已经不在守了').toBeGreaterThan(0);
    expect(refs.filter(({ ref }) => !exists(ref)).map(({ f, ref }) => `${rel(f)} → ${ref}`)).toEqual([]);
  });

  it('决策记录已经退场：目录不在了，源码里也不再引用任何编号', () => {
    expect(existsSync(join(REPO, 'docs', 'adr')), '决策记录目录应已删除').toBe(false);
    const refs = referencing.flatMap((f) => [...read(f).matchAll(RECORD_REF)].map((m) => `${rel(f)} → ${m[0]}`));
    expect(refs).toEqual([]);
  });

  it('两个判据自己抓得住它们要抓的形态', () => {
    // Built by concatenation so this file never trips its own scan.
    const plan = '04-effect-protocol' + '.md';
    expect(`see ${plan}'s notes`.match(MD_REF)).toEqual([plan]);
    expect(`see docs/plans/x/${plan}`.match(MD_REF)).toEqual([`docs/plans/x/${plan}`]);
    expect('ships in alias-loader.mjs'.match(MD_REF)).toBeNull();
    expect('see agent/thread/writer.ts and route-and-steps.spec.ts'.match(SOURCE_REF)).toEqual(['agent/thread/writer.ts', 'route-and-steps.spec.ts']);
    expect("import { step } from '@/agent/thread/machine';".match(SOURCE_REF)).toBeNull();
    for (const record of ['ADR' + ' 0009', 'ADR' + '-0008', 'ADR' + '0005', 'ADR' + '\n * 0005', 'ADR' + '\n  // 0006', 'docs/adr/' + '0012-x']) {
      expect(record.match(RECORD_REF), record).not.toBeNull();
    }
  });
});
