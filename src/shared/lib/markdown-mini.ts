// Tiny markdown converter for the bundled legal documents.
// Supports: # / ## headings, **bold**, - lists, [text](url) links.
// Anything else renders as text. Input is HTML-escaped first.

function escape(s: any) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(line: any) {
  let out = line;
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

export function shogunMarkdownMini(text: any) {
  const escaped = escape(String(text == null ? "" : text));
  const lines = escaped.split(/\r?\n/);
  const out: any[] = [];
  let para: any[] = [];
  let list: any[] = [];

  function flushPara() {
    if (para.length === 0) return;
    out.push("<p>" + renderInline(para.join(" ")) + "</p>");
    para = [];
  }
  function flushList() {
    if (list.length === 0) return;
    out.push(
      "<ul>" + list.map((s) => "<li>" + renderInline(s) + "</li>").join("") + "</ul>",
    );
    list = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    let m;
    if ((m = line.match(/^##\s+(.*)$/))) {
      flushPara();
      flushList();
      out.push("<h3>" + renderInline(m[1]) + "</h3>");
    } else if ((m = line.match(/^#\s+(.*)$/))) {
      flushPara();
      flushList();
      out.push("<h2>" + renderInline(m[1]) + "</h2>");
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      list.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("");
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).shogunMarkdownMini = shogunMarkdownMini;
}
