import { Fragment } from 'react';
import { readProse, type ProseInline, type ProseLine } from '@/shared/prose';

/**
 * What the model wrote at length, with the few Markdown marks it uses shown as
 * what they mean (`shared/prose.ts`). Built from elements, never from an HTML
 * string.
 */
export function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      {readProse(text).map((block, i) =>
        block.kind === 'para' ? (
          <p key={i}>{lines(block.lines)}</p>
        ) : block.ordered ? (
          <ol key={i} start={block.start}>
            {block.items.map((item, j) => (
              <li key={j}>{lines(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{lines(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

const lines = (ls: ProseLine[]) =>
  ls.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {line.map(inline)}
    </Fragment>
  ));

const inline = (x: ProseInline, i: number) =>
  x.kind === 'text' ? (
    <Fragment key={i}>{x.text}</Fragment>
  ) : x.kind === 'code' ? (
    <code key={i}>{x.text}</code>
  ) : (
    <strong key={i}>{x.parts.map(inline)}</strong>
  );
