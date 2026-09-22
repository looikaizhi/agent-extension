/**
 * What to show while the model is still writing.
 *
 * The answer arrives as the arguments of a tool call, streamed in fragments —
 * so what the panel has mid-flight is a piece of JSON that is not valid JSON
 * yet. This reads the one field worth showing out of that piece, as far as it
 * has arrived: the answer's words, or the reason for the step.
 *
 * It is a draft and nothing more. The host writes what actually landed, and
 * the panel drops this the moment the entry arrives — so a half-read escape
 * or a field that never completes can never become the record.
 */

/** Fields worth showing while they stream, most wanted first. */
const SHOWN = ['answer', 'why', 'question'] as const;

/** Decodes a JSON string body that may stop anywhere, escape included. */
function decode(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break; // the escape itself is still arriving
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'u') {
      const hex = body.slice(i + 1, i + 5);
      if (hex.length < 4) break; // half an escape: stop, do not guess
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += next; // \" \\ \/ and anything else stands for itself
  }
  return out;
}

/** The words the model has written so far, or `''` when it has written none. */
export function draftTextOf(args: string): string {
  for (const field of SHOWN) {
    const at = args.indexOf(`"${field}"`);
    if (at === -1) continue;
    const colon = args.indexOf(':', at + field.length + 2);
    if (colon === -1) continue;
    const open = args.indexOf('"', colon + 1);
    if (open === -1) continue;
    // The end of this string value, if it has ended: the first quote that is
    // not escaped.
    let end = -1;
    for (let i = open + 1; i < args.length; i++) {
      if (args[i] === '\\') i += 1;
      else if (args[i] === '"') {
        end = i;
        break;
      }
    }
    return decode(args.slice(open + 1, end === -1 ? args.length : end));
  }
  return '';
}
