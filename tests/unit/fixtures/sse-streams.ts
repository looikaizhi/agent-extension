/**
 * SSE stream fixtures, split between the two files that drive them.
 *
 * Each export is a `Uint8Array[]` — exactly the shape `reader.read()` hands
 * back, chunk by chunk. The chunk boundaries are the thing under test, so a
 * fixture that joined its pieces into one string before encoding would test
 * nothing: encode each boundary by hand instead.
 *
 * Which file a fixture belongs to says what it is *about*. One whose subject
 * is a boundary — CRLF, a line cut in two, a character cut in two, a missing
 * final newline, a heartbeat, a body past the cap — belongs to
 * `transport.spec.ts`, because those are SSE's problems and are solved once for
 * every protocol. One whose subject is what a line *says* — `[DONE]`, an error
 * object, a usage block — belongs to the adapter, which reads lines rather
 * than bytes, so those live as lines in `sse-lines.ts`.
 */

const enc = new TextEncoder();

/** Two data lines, each arriving as its own complete chunk (no boundary split). */
export function twoCompleteLines(): Uint8Array[] {
  return [
    enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
    enc.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
  ];
}

/** A `: keep-alive` comment line sits between two data lines, in its own chunk. */
export function heartbeatBetweenDataLines(): Uint8Array[] {
  return [
    enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'),
    enc.encode(': keep-alive\n\n'),
    enc.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
  ];
}

/** The line's own `\n` is withheld until the next `read()` — the boundary lands mid-line. */
export function lineSplitAcrossChunkBoundary(): Uint8Array[] {
  const whole = 'data: {"choices":[{"delta":{"content":"split across chunks"}}]}\n\n';
  const cut = whole.indexOf('across'); // cut somewhere in the middle of the JSON value
  return [enc.encode(whole.slice(0, cut)), enc.encode(whole.slice(cut))];
}

/** `中` is 3 UTF-8 bytes (E4 B8 AD); the chunk boundary lands after the first byte. */
export function multiByteCharSplitMidCharacter(): Uint8Array[] {
  const whole = enc.encode('data: {"choices":[{"delta":{"content":"中文"}}]}\n\n');
  const cut = whole.indexOf(0xe4) + 1; // one byte into the first CJK character
  return [whole.slice(0, cut), whole.slice(cut)];
}

/** CRLF line endings throughout, one chunk. */
export function crlfLineEndings(): Uint8Array[] {
  return [enc.encode('data: {"choices":[{"delta":{"content":"CRLF"}}]}\r\n\r\n')];
}

/** A data line survives after `[DONE]` — some proxies keep the socket open and echo it. */
export function dataAfterDone(): Uint8Array[] {
  return [
    enc.encode('data: {"choices":[{"delta":{"content":"before"}}]}\n\n'),
    enc.encode('data: [DONE]\n\n'),
    enc.encode('data: {"choices":[{"delta":{"content":"after, must be dropped"}}]}\n\n'),
  ];
}

/** The socket closes mid-line — no trailing `\n` at all, so the parser only sees this at EOF. */
export function finalLineWithoutNewline(): Uint8Array[] {
  return [enc.encode('data: {"choices":[{"delta":{"content":"tail with no newline"}}]}')];
}


/** No `usage` field anywhere in the stream — the default preset's actual behaviour. */
export function noUsageEver(): Uint8Array[] {
  return [
    enc.encode('data: {"choices":[{"delta":{"content":"1234"}}]}\n\n'),
    enc.encode('data: {"choices":[{"delta":{"content":"5678"}}]}\n\n'),
    enc.encode('data: [DONE]\n\n'),
  ];
}

/** HTTP 200, `text/event-stream`, but the payload is an error — some endpoints never leave the stream. */
export function errorObjectInStream(): Uint8Array[] {
  return [
    enc.encode(
      'data: {"error":{"message":"invalid_api_key","type":"invalid_request_error"}}\n\n',
    ),
  ];
}

/**
 * More raw bytes than `minBytes`, split into fixed chunks. Never contains a
 * newline — the cap must trip on raw byte volume as it arrives, independent
 * of whether any of it would ever have parsed as a complete SSE line.
 */
export function oversizedResponse(minBytes: number): Uint8Array[] {
  const chunkSize = 256 * 1024;
  const chunk = enc.encode('x'.repeat(chunkSize));
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= minBytes) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return chunks;
}
