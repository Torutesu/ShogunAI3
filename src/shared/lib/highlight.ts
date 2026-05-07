/**
 * FTS5 match-highlight renderer, shared by screens that display memory hits.
 *
 * The Rust `search_fts` path wraps matched spans in ASCII STX / ETX
 * (`\x02` / `\x03`) — sentinels that never occur in legitimate user text.
 * `renderHighlighted(text)` walks the string and emits a React node array
 * with each matched span wrapped in a `<mark>` element.
 *
 * Using real React elements (not `dangerouslySetInnerHTML`) keeps the output
 * HTML-safe: any angle brackets or script tags in the stored memory stay as
 * plain text.
 *
 * Inputs without sentinels are returned as-is, so callers can use the
 * helper unconditionally on any title / snippet field.
 */
import React from 'react';

const STX = String.fromCharCode(2);
const ETX = String.fromCharCode(3);

export function renderHighlighted(text: any) {
  if (typeof text !== 'string' || text.length === 0) return text || '';
  if (!text.includes(STX)) return text;
  const out: any[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const s = text.indexOf(STX, cursor);
    if (s < 0) {
      out.push(text.slice(cursor));
      break;
    }
    if (s > cursor) out.push(text.slice(cursor, s));
    const e = text.indexOf(ETX, s + 1);
    if (e < 0) {
      // Orphan start sentinel — strip it and keep the tail.
      out.push(text.slice(s + 1));
      break;
    }
    out.push(
      React.createElement('mark', { key: 'hl-' + key++ }, text.slice(s + 1, e))
    );
    cursor = e + 1;
  }
  return out;
}

export const ShogunHighlight = { renderHighlighted };
