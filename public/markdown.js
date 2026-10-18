// pi-chat markdown renderer.
// A small, dependency-free Markdown to HTML converter for assistant
// messages. Every raw text fragment is HTML-escaped before any markup
// is added, so agent output can never inject scripts or attributes.
// Only a safe subset of link targets is kept.
//
// Embedded media (svg, png, code blocks) are registered in
// mediaRegistry so the context menu in media.js can open, inspect,
// and download them.

const kMaxMediaEntries = 200;

// Media sources for the context menu: id -> { kind, source, lang, hash }.
const mediaRegistry = new Map();

// A small non-cryptographic hash for stable media ids.
function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// Register a media source and return its id. Re-registering the same
// source reuses the id; the oldest entry is evicted past the cap.
function registerMedia(kind, source, lang) {
  const hash = hashText(source);
  const id = `${kind}:${hash}`;
  mediaRegistry.set(id, { kind, source, lang, hash });
  if (mediaRegistry.size > kMaxMediaEntries) {
    mediaRegistry.delete(mediaRegistry.keys().next().value);
  }
  return id;
}

// Escape the HTML special characters in a raw text fragment.
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Return a safe href for a link target. Only http(s), mailto, and
// root-relative paths are kept; anything else becomes "#".
function safeUrl(url) {
  const target = String(url).trim();
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return target;
  if (target.startsWith("/") || target.startsWith("./")) return target;
  return "#";
}

// Render the inline markdown of a text fragment: code spans, links,
// bold, strikethrough, and italics. The input must be raw text;
// this function escapes it.
function renderInline(text) {
  // Pull code spans out first so their content is never formatted.
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  // Links: [label](url). The url is already escaped, so it is safe
  // inside the attribute.
  out = out.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_, label, url) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // Bold and strikethrough first, then italics, so the double-marker
  // forms are consumed before the single-marker ones.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  // Restore the code spans with escaped content.
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`);
  return out;
}

// True when a line starts a block-level construct.
function isBlockStart(line) {
  return (
    line.trim() === "" ||
    line.startsWith("```") ||
    /^#{1,6}\s/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

// True when the line is a table separator row (pipes, colons, dashes).
function isTableSeparator(line) {
  return (
    line.includes("|") &&
    line.includes("-") &&
    /^\s*\|?[\s:|-]+\|?\s*$/.test(line)
  );
}

// Split a table row into trimmed cell strings.
function splitTableRow(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

// Token rules per language family, in priority order. Rule sources
// must not use capturing groups.
const kJsRules = [
  { cls: "hl-com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
  { cls: "hl-str", re: /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
  { cls: "hl-kw", re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|export|from|default|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|delete|void|null|undefined|true|false)\b/ },
  { cls: "hl-num", re: /\b0[xX][\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { cls: "hl-fn", re: /[A-Za-z_$][\w$]*(?=\s*\()/ },
];

const kPyRules = [
  { cls: "hl-com", re: /#[^\n]*/ },
  { cls: "hl-str", re: /[rbuf]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/ },
  { cls: "hl-kw", re: /\b(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|pass|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await)\b/ },
  { cls: "hl-num", re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { cls: "hl-fn", re: /[A-Za-z_]\w*(?=\s*\()/ },
];

const kJsonRules = [
  { cls: "hl-attr", re: /"(?:\\.|[^"\\])*"(?=\s*:)/ },
  { cls: "hl-str", re: /"(?:\\.|[^"\\])*"/ },
  { cls: "hl-kw", re: /\b(?:true|false|null)\b/ },
  { cls: "hl-num", re: /-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
];

const kBashRules = [
  { cls: "hl-com", re: /#[^\n]*/ },
  { cls: "hl-str", re: /"(?:\\.|[^"\\])*"|'[^']*'/ },
  { cls: "hl-attr", re: /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9]+/ },
  { cls: "hl-kw", re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|exit|echo|cd|source|export|local|set|unset|shift|read|alias|eval|exec)\b/ },
  { cls: "hl-num", re: /\b\d+\b/ },
];

const kHtmlRules = [
  { cls: "hl-com", re: /<!--[\s\S]*?-->/ },
  { cls: "hl-str", re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/ },
  { cls: "hl-tag", re: /<\/?[a-zA-Z][\w:-]*|\/?>|<!DOCTYPE[^>]*>/ },
  { cls: "hl-attr", re: /\b[a-zA-Z-]+(?==)/ },
];

const kCssRules = [
  { cls: "hl-com", re: /\/\*[\s\S]*?\*\// },
  { cls: "hl-str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
  { cls: "hl-kw", re: /@[\w-]+/ },
  { cls: "hl-num", re: /#[\da-fA-F]{3,8}\b|\b\d[\d.]*(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|rad|turn|fr)?\b/ },
  { cls: "hl-attr", re: /[a-zA-Z-]+(?=\s*:)/ },
];

const kSqlRules = [
  { cls: "hl-com", re: /--[^\n]*|\/\*[\s\S]*?\*\// },
  { cls: "hl-str", re: /'(?:''|[^'\n])*'/ },
  { cls: "hl-kw", re: /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|join|left|right|inner|outer|on|as|and|or|not|null|primary|key|foreign|references|group|by|order|having|limit|offset|distinct|union|all|case|when|then|else|end|exists|between|like|in|is|with|count|sum|avg|min|max)\b/ },
  { cls: "hl-num", re: /\b\d[\d.]*(?:\.\d+)?\b/ },
];

const kCRules = [
  { cls: "hl-com", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
  { cls: "hl-str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/ },
  { cls: "hl-kw", re: /\b(?:int|float|double|char|void|long|short|unsigned|signed|const|static|struct|union|enum|class|public|private|protected|virtual|override|final|new|delete|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|throws|import|package|func|fn|let|mut|var|type|interface|impl|use|pub|mod|sizeof|typedef|template|typename|namespace|using|include|define|ifdef|ifndef|endif|pragma|auto|bool|true|false|nil|None|Some|match|loop|async|await|yield|goto|volatile|register|extern|export|this|super|extends|implements|abstract|synchronized|transient|do)\b/ },
  { cls: "hl-num", re: /\b0[xX][\da-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlL]?\b/ },
  { cls: "hl-fn", re: /[A-Za-z_]\w*(?=\s*\()/ },
];

const kYamlRules = [
  { cls: "hl-com", re: /#[^\n]*/ },
  { cls: "hl-str", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\])*'/ },
  { cls: "hl-attr", re: /[\w.-]+(?=\s*:)/ },
  { cls: "hl-kw", re: /\b(?:true|false|null)\b/ },
  { cls: "hl-num", re: /\b\d[\d.]*(?:\.\d+)?\b/ },
];

// Language aliases to token rules.
const kLangMap = {
  js: kJsRules, javascript: kJsRules, ts: kJsRules, typescript: kJsRules,
  jsx: kJsRules, tsx: kJsRules, node: kJsRules,
  py: kPyRules, python: kPyRules,
  json: kJsonRules,
  sh: kBashRules, bash: kBashRules, shell: kBashRules, zsh: kBashRules,
  html: kHtmlRules, xml: kHtmlRules,
  css: kCssRules, scss: kCssRules,
  sql: kSqlRules,
  c: kCRules, cpp: kCRules, "c++": kCRules, cs: kCRules, csharp: kCRules,
  java: kCRules, go: kCRules, golang: kCRules, rust: kCRules,
  yaml: kYamlRules, yml: kYamlRules,
};

// Run the ordered token rules over the code and wrap each match in a
// class span. Returns an HTML string of escaped text.
function highlightTokens(code, rules) {
  const master = new RegExp(rules.map((rule) => `(${rule.re.source})`).join("|"), "g");
  let out = "";
  let last = 0;
  let match;
  while ((match = master.exec(code)) !== null) {
    out += escapeHtml(code.slice(last, match.index));
    let cls = null;
    for (let g = 1; g < match.length; g += 1) {
      if (match[g] !== undefined) { cls = rules[g - 1].cls; break; }
    }
    out += cls ? `<span class="${cls}">${escapeHtml(match[0])}</span>` : escapeHtml(match[0]);
    last = match.index + match[0].length;
  }
  return out + escapeHtml(code.slice(last));
}

// Color diff/patch lines: added, removed, hunk, and file headers.
function highlightDiff(code) {
  return code.split("\n").map((line) => {
    let cls = "";
    if (/^\+\+\+/.test(line) || /^---/.test(line)) cls = "hl-file";
    else if (/^\+/.test(line)) cls = "hl-add";
    else if (/^-/.test(line)) cls = "hl-del";
    else if (/^@@/.test(line)) cls = "hl-hunk";
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  }).join("\n");
}

// Highlight a code string for a language. Unknown languages are
// escaped plain text.
function highlightCode(code, lang) {
  const key = String(lang).toLowerCase();
  if (key === "diff" || key === "patch") return highlightDiff(code);
  const rules = kLangMap[key];
  return rules ? highlightTokens(code, rules) : escapeHtml(code);
}

// Render a fenced code block: highlighted tokens plus a type icon
// with a right-click menu.
function codeBlock(codeText, lang) {
  const label = lang || "code";
  const id = registerMedia("code", codeText, lang);
  return `<div class="media" data-media-id="${id}">` +
    `<button class="media-icon" type="button" title="Right-click for options">${escapeHtml(label)}</button>` +
    `<pre class="code-block"><code>${highlightCode(codeText, lang)}</code></pre></div>`;
}

// Render an embedded image (svg or png) with a type icon and a
// right-click menu.
function mediaImage(url, alt, kind) {
  const id = registerMedia(kind, url, "");
  return `<div class="media" data-media-id="${id}">` +
    `<button class="media-icon" type="button" title="Right-click for options">${kind === "svg" ? "svg" : "img"}</button>` +
    `<img class="media-img" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"></div>`;
}

// Parse a table starting at lines[index]. Returns { header, rows,
// next } or null when the line is not a table header.
function tableAt(lines, index) {
  const line = lines[index];
  if (!line.includes("|") || index + 1 >= lines.length || !isTableSeparator(lines[index + 1])) return null;
  const header = splitTableRow(line);
  let i = index + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
    rows.push(splitTableRow(lines[i]));
    i += 1;
  }
  return { header, rows, next: i };
}

// Render a markdown string to an HTML string. The output contains
// only the tags this file generates; all raw text is escaped.
// Supports fenced code, headings, lists, tables, quotes, rules, and
// inline emphasis.
function renderMarkdown(src) {
  const lines = String(src).split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block, or an embedded svg when the content is one.
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i += 1;
      const code = [];
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i += 1; // skip the closing fence (or run past the end)
      const codeText = code.join("\n");
      if (/<svg[\s>/]/i.test(codeText)) {
        html += mediaImage(`data:image/svg+xml;utf8,${encodeURIComponent(codeText)}`, "", "svg");
      } else {
        html += codeBlock(codeText, lang);
      }
      continue;
    }
    // Blank line.
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    // Heading, capped at h4 for chat sizing.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }
    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html += "<hr>";
      i += 1;
      continue;
    }
    // Blockquote.
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      }
      html += `<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`;
      continue;
    }
    // Table.
    const table = tableAt(lines, i);
    if (table) {
      const head = table.header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const body = table.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("");
      html += `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      i = table.next;
      continue;
    }
    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      }
      html += `<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`;
      continue;
    }
    // Ordered list.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      }
      html += `<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`;
      continue;
    }
    // Image: ![alt](url). Remote http(s) and data:image urls embed;
    // anything else falls back to a plain link.
    const image = line.match(/^!\[([^\]]*)\]\(([^()\s]+)\)/);
    if (image) {
      const url = image[2];
      if (/^(https?:|data:image\/)/.test(url)) {
        const kind = url.startsWith("data:image/svg") ? "svg" : "image";
        html += mediaImage(url, image[1], kind);
      } else {
        html += `<p><a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(image[1] || url)}</a></p>`;
      }
      i += 1;
      continue;
    }
    // Paragraph: a run of plain lines; single newlines become <br>.
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i++]);
    }
    html += `<p>${renderInline(para.join("\n")).replace(/\n/g, "<br>")}</p>`;
  }
  return html;
}
