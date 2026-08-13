import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Replaces ESLint with three assertions that actually matter here. Each guards
 * an invariant that would decay silently: nobody notices a slow extractor until
 * a console page janks, and nobody notices an S-05 leak until an audit.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const read = (p: string) => readFileSync(p, 'utf8');
/** Strip comments so prose about a banned API does not trip the guard. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('架构护栏', () => {
  it('抽取器不得调用 getComputedStyle（性能护栏）', () => {
    const offenders = files
      .filter((f) => f.includes(join('core', 'extractor')))
      .filter((f) => code(read(f)).includes('getComputedStyle('));
    expect(offenders).toEqual([]);
  });

  it('抽取管线不得读取输入框的 value（S-05）', () => {
    // `.value` on an <input> is the user's data and must never leave the page.
    // Boolean IDL attributes (checked/disabled/required) are fine.
    const offenders = files
      .filter((f) => f.includes(join('core', 'extractor')) || f.includes(join('core', 'security')))
      .filter((f) => /\.value\b/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it('agent 边界不得从排序结果里盲取第一名（K-6 覆盖 baseline 路径）', () => {
    // `bind` is forbidden from breaking a tie, but the lexical path used to do
    // exactly that with `scoreNodes(...)[0]` — and that scorer is also step 2's
    // `relocate`, so the guarantee leaked out through the one path where a
    // silent mis-point is least visible.
    const api = code(read(join(SRC, 'agent/api.ts')));
    expect(api).not.toMatch(/scoreNodes/);
    expect(api).not.toMatch(/\)\[0\]/);
  });

  it('绑定逻辑不得排序或打分（K-6）', () => {
    // Silent mis-binding can only be born from "pick one of several", and the
    // usual way that creeps in is a sort or a score. Indexing `candidates[0]`
    // is fine *inside* a length===1 branch, so that is covered behaviourally in
    // bind.spec.ts rather than by grep.
    const bind = code(read(join(SRC, 'core/packs/bind.ts')));
    expect(bind).not.toMatch(/\.sort\(/);
    expect(bind).not.toMatch(/score/i);
    expect(bind).not.toMatch(/\.slice\(0,\s*1\)/);
  });

  it('UINode 的字段白名单不含任何页面文本载体', () => {
    const types = read(join(SRC, 'core/extractor/types.ts'));
    const uinode = types.slice(types.indexOf('export interface UINode'));
    const body = uinode.slice(0, uinode.indexOf('\n}'));
    for (const banned of ['text:', 'html:', 'value:', 'innerText', 'textContent']) {
      expect(body).not.toContain(banned);
    }
  });

  it('页面侧代码不得依赖仅在安全上下文可用的 API', () => {
    // `crypto.randomUUID()` threw on every plain-http page with a normal
    // hostname, and nothing caught it: `localhost` and `127.0.0.1` *are* secure
    // contexts, so the entire fixture corpus and every measured real site
    // happened to be immune. Internal consoles on http:// are the target user.
    const pageSide = files.filter(
      (f) => f.includes(join('core', 'extractor')) || f.includes(join('core', 'overlay')) || f.endsWith(join('entrypoints', 'content.ts')),
    );
    for (const f of pageSide) {
      const src = code(read(f));
      for (const banned of ['crypto.randomUUID', 'crypto.subtle', 'navigator.clipboard', 'navigator.locks'])
        expect([f, src.includes(banned)]).toEqual([f, false]);
    }
  });

  it('投影是纯函数：不得读取任何实时视口状态', () => {
    // The F-5 fix rests entirely on band maths coming from `view.viewport`
    // rather than from live globals — one `window.innerHeight` and `nth` is
    // scroll-dependent again. The unit tests run under `environment: 'node'`,
    // so such a read would surface as a confusing ReferenceError deep in a
    // fixture rather than as this sentence.
    const src = code(read(join(SRC, 'core/extractor/project.ts')));
    for (const banned of [
      'window.',
      'document.',
      'visualViewport',
      'scrollY',
      'scrollX',
      'getBoundingClientRect',
    ]) {
      expect(src).not.toContain(banned);
    }
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
    const ACTING = [
      /\.click\s*\(/,
      /\.focus\s*\(/,
      /\.blur\s*\(/,
      /\.submit\s*\(/,
      /dispatchEvent\s*\(/,
      /new\s+(Mouse|Keyboard|Pointer|Input|Touch)Event/,
      /execCommand\s*\(/,
      /\.select\s*\(\s*\)/,
      /\.setSelectionRange\s*\(/,
      /document\.designMode/,
    ];
    const offenders = files
      .filter((f) => !f.includes('tests'))
      .flatMap((f) => {
        const src = code(read(f));
        return ACTING.filter((re) => re.test(src)).map((re) => `${f} :: ${re}`);
      });
    expect(offenders).toEqual([]);
  });

  it('content script 的指令集是封闭的，且没有执行类动词', async () => {
    // Adding a verb must be a deliberate act with a visible diff, not something
    // that arrives inside an unrelated change. `RPC_TYPES` is the runtime
    // whitelist `onRequest` enforces, and protocol.ts carries a compile-time
    // proof that it and `ContentRpcMap` cannot drift — so asserting the one
    // value covers both.
    const { RPC_TYPES } = await import('@/shared/protocol');
    expect([...RPC_TYPES].sort()).toEqual(
      ['CLEAR', 'DEBUG_GET_OVERLAY_STATE', 'EXTRACT', 'HIGHLIGHT', 'INSPECT', 'PING'].sort(),
    );
    for (const banned of ['EXECUTE', 'CLICK', 'FILL', 'TYPE', 'SUBMIT', 'NAVIGATE', 'EVAL']) {
      expect(RPC_TYPES as readonly string[]).not.toContain(banned);
    }
  });

  it('只有 provider 层可以发起网络请求', () => {
    // Narrowed from "nothing may" when P-03 arrived. The point was never the
    // absence of network code — it was that the API key has exactly one
    // destination. Keeping the assertion but naming the single exception is
    // what makes "永不出扩展" checkable instead of promised.
    const offenders = files
      .filter((f) => !f.includes('tests'))
      .filter((f) => !f.endsWith(join('agent', 'provider.ts')))
      .filter((f) => /\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

  it('content script 不得触碰扩展存储（密钥隔离）', () => {
    // The content script shares a process with the page. Anything it can read,
    // a page bug can eventually reach — so it must never be able to read the
    // key at all, rather than merely choosing not to.
    const cs = code(read(join(SRC, 'entrypoints/content.ts')));
    expect(cs).not.toMatch(/chrome\.storage/);
    for (const f of files.filter((f) => f.includes(join('core', 'extractor')) || f.includes(join('core', 'overlay'))))
      expect([f, /chrome\.storage/.test(code(read(f)))]).toEqual([f, false]);
  });

  it('API Key 不得进入日志或事件流', () => {
    const settings = read(join(SRC, 'shared/settings.ts'));
    // storage.sync would replicate the key to Google's servers, which is the
    // exact opposite of what the UI tells the user.
    expect(code(settings)).not.toMatch(/storage\.sync/);
    const offenders = files
      .filter((f) => !f.includes('tests') && !f.endsWith('settings.ts') && !f.endsWith(join('agent', 'provider.ts')))
      .filter((f) => /apiKey/.test(code(read(f))) && /console\.|emit\(|broadcast\(/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });

});
