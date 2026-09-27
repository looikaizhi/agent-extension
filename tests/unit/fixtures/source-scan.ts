import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

/**
 * Reading the shipped source as data.
 *
 * Extracted so `architecture.spec.ts` and `gates.spec.ts` scan the same tree
 * the same way. D3's `executed` gate and the architecture guard behind it are
 * two views of one fact — "this extension never acts on the page" — and two
 * copies of the walker would let them drift into disagreeing about which files
 * even count.
 *
 * The guards read the tree the compiler parses, never the text (see below).
 */
const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

export const sourceFiles = (): string[] => walk(SRC);
export const readSource = (p: string): string => readFileSync(p, 'utf8');

/* ═══════════ the source as a syntax tree ═══════════
 *
 * The guards used to be regular expressions over comment-stripped text, and
 * text cannot tell an import from a string that looks like one, a call from a
 * mention of one, or `chrome-extension://` from `chrome.`. Every guard carried
 * its own workaround, and the single-writer guard sat green while its pattern
 * matched no import the code actually wrote. The compiler already knows what
 * each of those things is, so the guards ask it instead.
 *
 * Comments are not in the tree at all, so nothing here strips them.
 */

export interface ImportFact {
  module: string;
  /** `import type { … }` — the whole declaration is erased at runtime. */
  typeOnly: boolean;
  named: { imported: string; local: string; typeOnly: boolean }[];
  /** `import * as ns` → `ns`; `export * from` → `*`. */
  namespace?: string;
  /** `export { … } from` / `export * from`: a second door to the same module. */
  reexport: boolean;
  /** `import('…')`. */
  dynamic: boolean;
}

export interface Facts {
  /** Every call, by the dotted name of what is called (`chrome.tabs.sendMessage`, `el.focus`, `fetch`). */
  calls: { chain: string; args: string[] }[];
  /** Every `new X(...)`, by the dotted name of `X`. */
  news: string[];
  /** Every property access, as its full dotted chain. */
  accesses: string[];
  /** Every identifier and property name that appears in code — declarations, references, types. */
  names: Set<string>;
  /** Every string literal and template piece. */
  strings: string[];
  /** `await` and `for await`. */
  awaits: number;
  imports: ImportFact[];
  /** Object-literal properties, with the value when it is a plain string. */
  properties: { name: string; value?: string }[];
}

/** `a.b.c` for a name chain; `…` stands for any link that is not a name (a call result, an index). */
export function chainOf(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (e.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(e)) return `${chainOf(e.expression)}.${e.name.text}`;
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return chainOf(e.expression);
  return '…';
}
export const lastSegment = (chain: string): string => chain.slice(chain.lastIndexOf('.') + 1);
/** Whether `chain` contains `path` as consecutive links (`window.crypto.randomUUID` has `crypto.randomUUID`). */
export function chainHas(chain: string, path: string): boolean {
  const c = chain.split('.');
  const p = path.split('.');
  for (let i = 0; i + p.length <= c.length; i++) if (p.every((s, j) => c[i + j] === s)) return true;
  return false;
}
const isMethodCall = (chain: string, name: string) => chain.includes('.') && lastSegment(chain) === name;

export function factsOfText(text: string, path = 'snippet.ts'): Facts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const f: Facts = { calls: [], news: [], accesses: [], names: new Set(), strings: [], awaits: 0, imports: [], properties: [] };
  const textOf = (n: ts.Node) => n.getText(sf);
  const nameOf = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n) ? n.text : textOf(n));
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [arg] = n.arguments;
        if (arg && ts.isStringLiteralLike(arg))
          f.imports.push({ module: arg.text, typeOnly: false, named: [], reexport: false, dynamic: true });
      } else f.calls.push({ chain: chainOf(n.expression), args: n.arguments.map(textOf) });
    } else if (ts.isNewExpression(n)) f.news.push(chainOf(n.expression));
    else if (ts.isPropertyAccessExpression(n)) f.accesses.push(chainOf(n));
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      f.accesses.push(`${chainOf(n.expression)}.${n.argumentExpression.text}`);
      f.names.add(n.argumentExpression.text);
    } else if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) f.names.add(n.text);
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) f.strings.push(n.text);
    else if (ts.isTemplateExpression(n)) f.strings.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    else if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) f.awaits++;
    else if (ts.isPropertyAssignment(n))
      f.properties.push({ name: nameOf(n.name), ...(ts.isStringLiteralLike(n.initializer) ? { value: n.initializer.text } : {}) });
    else if (ts.isShorthandPropertyAssignment(n)) f.properties.push({ name: n.name.text });
    else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.importClause;
      const bindings = clause?.namedBindings;
      f.imports.push({
        module: n.moduleSpecifier.text,
        typeOnly: Boolean(clause?.isTypeOnly),
        named:
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: e.isTypeOnly }))
            : [],
        ...(bindings && ts.isNamespaceImport(bindings) ? { namespace: bindings.name.text } : {}),
        reexport: false,
        dynamic: false,
      });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const clause = n.exportClause;
      f.imports.push({
        module: n.moduleSpecifier.text,
        typeOnly: n.isTypeOnly,
        named:
          clause && ts.isNamedExports(clause)
            ? clause.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: e.isTypeOnly }))
            : [],
        ...(clause ? {} : { namespace: '*' }),
        reexport: true,
        dynamic: false,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return f;
}

const factCache = new Map<string, Facts>();
export function factsOf(path: string): Facts {
  let f = factCache.get(path);
  if (!f) factCache.set(path, (f = factsOfText(readSource(path), path)));
  return f;
}

const readIfExists = (p: string): string | undefined =>
  existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : undefined;

/** The path aliases WXT writes into tsconfig: `@` and `~` for the source
 *  tree, `@@` and `~~` for the project root. Longest first. */
const ALIASES: readonly (readonly [string, string])[] = [
  ['@@', process.cwd()],
  ['~~', process.cwd()],
  ['@', SRC],
  ['~', SRC],
];

/**
 * The file a module specifier names inside this tree, or `undefined` for a
 * package.
 *
 * A specifier that points into the tree and names nothing is an error, not a
 * package. Dropping it would let the closure stop short while every rule run
 * over it stays green — the same false green the guards moved off regex to end.
 */
function resolveImport(from: string, module: string, readText: (p: string) => string | undefined): string | undefined {
  const alias = ALIASES.find(([a]) => module === a || module.startsWith(`${a}/`));
  const base = alias ? join(alias[1], module.slice(alias[0].length)) : module.startsWith('.') ? join(dirname(from), module) : undefined;
  if (base === undefined) return undefined;
  const stem = base.replace(/\.js$/, '');
  const found = [base, `${stem}.ts`, `${stem}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
    (p) => /\.(ts|tsx)$/.test(p) && readText(p) !== undefined,
  );
  if (!found) throw new Error(`importClosure: "${module}"（来自 ${from}）指向这棵源码树，却找不到对应的文件`);
  return found;
}

/**
 * Every file of this tree that `entry` loads at runtime, following imports the
 * way the compiler emits them.
 *
 * `verbatimModuleSyntax` is on, so the only imports that disappear are the ones
 * written `import type` / `export type`. `import { type X }` survives as a bare
 * `import 'x'` and still loads the module, so it is followed. Packages are not:
 * the guards are about this tree.
 *
 * `readText` answers `undefined` for a file that does not exist, and is a
 * parameter so the closure itself can be proven against a made-up tree.
 *
 * `types: true` follows `import type` as well — for the guards about who
 * *knows about* whom, where a type is as much a dependency as a value.
 */
export function importClosure(
  entry: string,
  readText: (p: string) => string | undefined = readIfExists,
  { types = false }: { types?: boolean } = {},
): string[] {
  const reached = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    const text = readText(file);
    if (text === undefined) continue;
    reached.add(file);
    for (const i of factsOfText(text, file).imports) {
      if (i.typeOnly && !types) continue;
      const target = resolveImport(file, i.module, readText);
      if (target) pending.push(target);
    }
  }
  return [...reached];
}

/**
 * Every API that would make the page do something on the user's behalf.
 *
 * `focus()` is deliberately absent and carries its own narrower guard: a
 * focused button sits there until a key is pressed, and that keystroke is a
 * real user gesture the page receives from the browser rather than from us.
 * Everything below is activation, which is the line 「只指路，不开车」 draws.
 */
export const ACTING_RULES: readonly { name: string; hit: (f: Facts) => boolean }[] = [
  { name: '.click()', hit: (f) => f.calls.some((c) => isMethodCall(c.chain, 'click')) },
  { name: '.blur()', hit: (f) => f.calls.some((c) => isMethodCall(c.chain, 'blur')) },
  { name: 'dispatchEvent()', hit: (f) => f.calls.some((c) => lastSegment(c.chain) === 'dispatchEvent') },
  { name: '.submit()', hit: (f) => f.calls.some((c) => isMethodCall(c.chain, 'submit')) },
  { name: 'new …Event', hit: (f) => f.news.some((n) => /^(Mouse|Keyboard|Pointer|Input|Touch)Event$/.test(lastSegment(n))) },
  { name: 'execCommand()', hit: (f) => f.calls.some((c) => lastSegment(c.chain) === 'execCommand') },
  { name: '.select()', hit: (f) => f.calls.some((c) => isMethodCall(c.chain, 'select') && c.args.length === 0) },
  { name: '.setSelectionRange()', hit: (f) => f.calls.some((c) => isMethodCall(c.chain, 'setSelectionRange')) },
  { name: 'document.designMode', hit: (f) => f.accesses.some((a) => chainHas(a, 'document.designMode')) },
];

/**
 * Words that name doing something to the page on the user's behalf. A name —
 * an intent the model can call, a verb the host can send the content script —
 * is split into words (at `_`, `-`, spaces and camelCase humps), and any one
 * of these makes it an act. Asked of the words, not of a list of whole names,
 * so `FILL_INPUT`, `execute_script` and `submitForm` are caught along with
 * `act` and `CLICK`.
 */
export const ACTING_WORDS: ReadonlySet<string> = new Set([
  'act', 'click', 'tap', 'press', 'type', 'fill', 'input', 'select', 'check', 'toggle', 'submit',
  'navigate', 'goto', 'open', 'scroll', 'drag', 'drop', 'hover', 'focus', 'execute', 'exec', 'eval',
  'run', 'key', 'keys', 'set', 'write', 'upload', 'paste',
]);

/** The words in `name` that make it an act; empty when it is not one. */
export function actingWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter((w) => ACTING_WORDS.has(w));
}

/**
 * N-2: what `machine.ts` may not contain. `await` — a reducer that can suspend
 * cannot be replayed deterministically from a persisted `ThreadState`. `fetch(`
 * and `chrome` — a reducer that reaches the outside world cannot run in a node
 * test, and cannot survive the service worker being evicted mid-flight.
 */
export const N2_RULES: readonly { name: string; hit: (f: Facts) => boolean }[] = [
  { name: 'await', hit: (f) => f.awaits > 0 },
  { name: 'fetch(', hit: (f) => f.calls.some((c) => lastSegment(c.chain) === 'fetch') },
  { name: 'chrome', hit: (f) => f.names.has('chrome') },
];

/**
 * Every file `entry` loads that breaks an N-2 rule, with the rules it breaks.
 * The guard and its reverse test both go through this, so what the reverse
 * test proves is the guard itself rather than a copy of it.
 */
export function purityOffenders(
  entry: string,
  readText: (p: string) => string | undefined = readIfExists,
): { file: string; rules: string[] }[] {
  return importClosure(entry, readText)
    .map((file) => ({ file, rules: N2_RULES.filter((r) => r.hit(factsOfText(readText(file)!, file))).map((r) => r.name) }))
    .filter((o) => o.rules.length > 0);
}

/** Files (outside tests) that use any of them, as `path :: rule`. */
export function actingOffenders(): string[] {
  return sourceFiles()
    .filter((f) => !f.includes('tests'))
    .flatMap((f) => {
      const facts = factsOf(f);
      return ACTING_RULES.filter((r) => r.hit(facts)).map((r) => `${f.replace(`${process.cwd()}/`, '')} :: ${r.name}`);
    });
}

const fromMachine = (module: string) => /(^|\/)machine$/.test(module);
/**
 * The single-writer chain: exactly one module may *call* the reducer's `step`.
 * The danger is not a defect `step` could exhibit — it is a pure function and
 * cannot refuse a caller — it is a *second* process running the same reducer
 * to optimistically predict a cursor move.
 *
 * Asked as "who calls it", not "who imports it": the import form used to be
 * the test, and it was green for the wrong reason twice over — its pattern
 * matched no path a real import used, and the module it named imported `step`
 * without ever calling it. A type-only import cannot satisfy this; a renamed or
 * namespaced one still does.
 */
export function callsReducerStep(src: string): boolean {
  const f = factsOfText(src);
  const callers = new Set<string>();
  for (const i of f.imports) {
    if (i.typeOnly || i.reexport || i.dynamic || !fromMachine(i.module)) continue;
    for (const n of i.named) if (n.imported === 'step' && !n.typeOnly) callers.add(n.local);
    if (i.namespace) callers.add(`${i.namespace}.step`);
  }
  return f.calls.some((c) => callers.has(c.chain));
}
/** A module that re-exports `step` is a second door to the reducer: anything importing from it can call it. */
export function reexportsReducerStep(src: string): boolean {
  return factsOfText(src).imports.some(
    (i) => i.reexport && fromMachine(i.module) && (i.namespace === '*' || i.named.some((n) => n.imported === 'step')),
  );
}
/**
 * The decide/execute split: nothing under `agent/thread/` may reach the
 * agent's run loop (`agent/agents/guide/runner.ts`) — the one file under
 * `src/agent` that opens a socket.
 * Any import counts — type-only, dynamic, or a re-export — because a guard on
 * `machine.ts`'s own text cannot see a network call two files away.
 */
export const runnerImport = (f: Facts): boolean => f.imports.some((i) => /(^|\/)guide\/runner$|^\.\/runner$/.test(i.module));
export function importsRunner(src: string): boolean {
  return runnerImport(factsOfText(src));
}
/** P-1 stayed deferred: no registrable-domain or same-party inference, in any name or string. */
export const PARTY_RULES: readonly RegExp[] = [/eTLD/i, /registrable/i, /publicSuffix/i, /psl\b/i];
export function partyGuessing(f: Facts): RegExp[] {
  const words = [...f.names, ...f.strings];
  return PARTY_RULES.filter((re) => words.some((w) => re.test(w)));
}
