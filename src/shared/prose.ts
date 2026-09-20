/**
 * The little Markdown a model writes, read as structure — never as markup.
 *
 * The model's answers use a few of Markdown's marks — bold, bullet lists,
 * inline code, blank-line paragraphs (measured on the live runs) — and shown
 * as plain text the marks are only noise. This reads those, and nothing
 * else, into blocks that the side panel and the overlay each build out of
 * their own elements and text nodes, never out of an HTML string: an answer
 * quotes the page, and nothing the page says may become markup here. What is
 * not read stays exactly as the model wrote it — a link included, so nothing
 * the model writes becomes something to click.
 *
 * Only for what the model writes at length (an answer, a question, why this
 * step, why the run ended). Names and titles taken from the page are shown as
 * they are.
 */

export type ProseText = { kind: 'text'; text: string } | { kind: 'code'; text: string };
export type ProseInline = ProseText | { kind: 'strong'; parts: ProseText[] };
/** What sits between two line breaks. */
export type ProseLine = ProseInline[];
export type ProseList =
  | { kind: 'list'; ordered: false; items: ProseLine[][] }
  | { kind: 'list'; ordered: true; start: number; items: ProseLine[][] };
export type ProseBlock = { kind: 'para'; lines: ProseLine[] } | ProseList;

const BULLET = /^(\s*)[-*•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*?)(?:\s+#+)?$/;

export function readProse(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let para: ProseLine[] | null = null;
  let list: ProseList | null = null;
  const endPara = () => {
    if (para) blocks.push({ kind: 'para', lines: para });
    para = null;
  };
  const endList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      endPara();
      endList();
      continue;
    }
    const indented = raw.length > raw.trimStart().length;

    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    if (bullet || numbered) {
      endPara();
      const ordered = numbered !== null;
      const item = [readLine((bullet ? bullet[2] : numbered![3])!.trim())];
      // An indented item is a sub-list, flattened into the list it hangs off.
      if (list && (indented || list.ordered === ordered)) {
        list.items.push(item);
      } else {
        endList();
        list = numbered ? { kind: 'list', ordered: true, start: Number(numbered[2]), items: [item] } : { kind: 'list', ordered: false, items: [item] };
      }
      continue;
    }

    // An indented line under a list item goes on with that item.
    if (list && indented) {
      list.items.at(-1)!.push(readLine(line));
      continue;
    }
    endList();

    const heading = HEADING.exec(line);
    para ??= [];
    para.push(heading ? [{ kind: 'strong', parts: readText(heading[1]!) }] : readLine(line));
  }
  endPara();
  endList();
  return blocks;
}

/** The end of the code span opening at `from`, or -1. */
const codeEnd = (s: string, from: number): number => {
  const end = s.indexOf('`', from + 1);
  return end > from + 1 ? end : -1;
};

/** Where the bold opened just before `from` closes, skipping code spans; -1 if it never does. */
function strongEnd(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '`') {
      const end = codeEnd(s, i);
      if (end !== -1) i = end;
    } else if (s.startsWith('**', i)) return i;
  }
  return -1;
}

/** One line's inline marks. With `strong` off, only code spans are read — bold's inside. */
function readLine(s: string, strong = true): ProseLine {
  const out: ProseLine = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
  };
  for (let i = 0; i < s.length; ) {
    if (s[i] === '`') {
      const end = codeEnd(s, i);
      if (end !== -1) {
        flush();
        out.push({ kind: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (strong && s.startsWith('**', i)) {
      const end = strongEnd(s, i + 2);
      const inner = end === -1 ? '' : s.slice(i + 2, end);
      // Bold hugs its words: `2 ** 3 ** 2` is arithmetic, not emphasis.
      if (inner && inner.trim() === inner) {
        flush();
        out.push({ kind: 'strong', parts: readText(inner) });
        i = end + 2;
        continue;
      }
    }
    plain += s[i];
    i += 1;
  }
  flush();
  return out;
}

/** Text and code spans, no bold: what may sit inside bold. */
const readText = (s: string): ProseText[] => readLine(s, false) as ProseText[];
