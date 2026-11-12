/* Small, dependency-free Markdown renderer tuned for chat transcripts. */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(url) || url.startsWith("/") || url.startsWith("#");
}

/** Path-like hrefs in chat markdown become workspace file links (server still enforces bounds). */
export function resolveMarkdownFileHref(href) {
  const url = String(href || "").trim();
  if (!url) return null;
  if (/^(https?:|mailto:|data:|javascript:|vbscript:|blob:)/i.test(url)) return null;
  if (url.startsWith("#")) return null;
  if (/^\/(api|js|icons)\//.test(url) || url === "/" || url === "/index.html" || url === "/styles.css" || url === "/logo.svg" || url === "/manifest.webmanifest" || url === "/sw.js") {
    return null;
  }
  let path = url;
  if (/^file:/i.test(url)) {
    try {
      const parsed = new URL(url);
      path = decodeURIComponent(parsed.pathname || "");
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  if (path.startsWith("/") && path.indexOf("/", 1) === -1 && path.includes(".")) {
    // single-segment "/styles.css"-like: treat as site path, not a file
    return null;
  }
  if (!path.startsWith("/") && !path.startsWith("./") && !path.startsWith("../") && !/^[A-Za-z]:[\\/]/.test(path)) {
    // relative "foo.md" or "out/a.pdf"
    if (!path || /\s/.test(path)) return null;
  }
  return path;
}

function workspaceFileAnchor(label, path) {
  const href = "/api/file?path=" + encodeURIComponent(path) + "&mode=download";
  return (
    '<a class="ws-file" href="' + escapeHtml(href) + '" data-ws-file="' + escapeHtml(path) + '">' +
    escapeHtml(label) +
    "</a>"
  );
}

const JS_RE = /(?<cm>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<str>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<num>\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|interface|type|implements|public|private|protected|static|readonly|enum|as|in|of|delete|void|yield|super|get|set)\b)/g;

const PY_RE = /(?<cm>#[^\n]*)|(?<str>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<num>\b\d+(?:\.\d+)?\b)|(?<kw>\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|lambda|None|True|False|and|or|not|in|is|global|nonlocal|pass|break|continue|yield|async|await|assert|del|match|case)\b)/g;

const BASH_RE = /(?<cm>(?:^|\s)#[^\n]*)|(?<str>"[^"]*"|'[^']*')|(?<num>\b\d+\b)|(?<kw>\b(?:if|then|else|elif|fi|for|do|done|while|until|case|esac|function|in|export|local|readonly|return|echo|cd|ls|grep|sed|awk|cat|rm|mv|cp|mkdir|git|npm|node|curl|chmod|sudo|source|set|shift|trap|exit)\b)/g;

const JSON_RE = /(?<key>"(?:\\.|[^"\\])*"(?=\s*:))|(?<kw>true|false|null)\b|(?<str2>"(?:\\.|[^"\\])*")|(?<num>-?\b\d+(?:\.\d+)?\b)/g;

const CSS_RE = /(?<cm>\/\*[\s\S]*?\*\/)|(?<str>"[^"]*"|'[^']*')|(?<num>#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\b)/g;

function patternFor(lang) {
  const l = String(lang || "").toLowerCase();
  if (["js", "javascript", "ts", "typescript", "jsx", "tsx", "mjs", "node"].includes(l)) return JS_RE;
  if (["py", "python"].includes(l)) return PY_RE;
  if (["bash", "sh", "shell", "zsh", "console"].includes(l)) return BASH_RE;
  if (["json", "jsonc"].includes(l)) return JSON_RE;
  if (["css", "scss", "less"].includes(l)) return CSS_RE;
  return null;
}

export function highlight(code, lang) {
  const pattern = patternFor(lang);
  if (!pattern) return escapeHtml(code);
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(code))) {
    if (!match[0].length) {
      pattern.lastIndex += 1;
      continue;
    }
    out += escapeHtml(code.slice(last, match.index));
    const g = match.groups || {};
    const cls = g.cm ? "tok-cm" : g.str || g.str2 || g.key ? "tok-str" : g.num ? "tok-num" : g.kw ? "tok-kw" : "";
    const text = escapeHtml(match[0]);
    out += cls ? '<span class="' + cls + '">' + text + "</span>" : text;
    last = match.index + match[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function codeBlock(code, lang) {
  const label = (lang || "text").replace(/[^\w+#.-]/g, "");
  return (
    '<div class="code">' +
    '<div class="code-head"><span>' + escapeHtml(label) + '</span>' +
    '<button class="code-copy" data-copy type="button">复制</button></div>' +
    '<pre><code class="lang-' + escapeHtml(label) + '">' + highlight(code, lang) + "</code></pre>" +
    "</div>"
  );
}

function inline(raw) {
  const stash = [];
  const keep = (html) => {
    stash.push(html);
    return "\u0000" + (stash.length - 1) + "\u0000";
  };

  let text = String(raw);

  text = text.replace(/[\x60]([^\x60\n]+)[\x60]/g, (_, code) => keep("<code>" + escapeHtml(code) + "</code>"));

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    if (!/^https?:/i.test(url)) return alt;
    return keep('<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '" loading="lazy">');
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const filePath = resolveMarkdownFileHref(url);
    if (filePath) return keep(workspaceFileAnchor(label, filePath));
    if (!safeUrl(url)) return label;
    return keep(
      '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + "</a>",
    );
  });

  text = escapeHtml(text);

  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  text = text.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"')\]]+)/g, (match, lead, url) => {
    return lead + keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
  });

  text = text.replace(/\n/g, "<br>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)] ?? "");
  return text;
}

function indentOf(line) {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].replace(/\t/g, "  ").length : 0;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  if (!lines[i].includes("|")) return false;
  const sep = lines[i + 1];
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sep) && sep.includes("-");
}

function checkboxify(html) {
  return html
    .replace(/^\[ \]\s+/, '<span class="task-box"></span>')
    .replace(/^\[[xX]\]\s+/, '<span class="task-box done"></span>');
}

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let i = 0;

  const flush = () => {
    if (!paragraph.length) return;
    out.push("<p>" + inline(paragraph.join("\n")) + "</p>");
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*([\x60]{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const marker = fence[1][0];
      const size = fence[1].length;
      const lang = fence[2] || "";
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp("^\\s*\\" + marker + "{" + size + ",}\\s*$").test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(codeBlock(body.join("\n"), lang));
      continue;
    }

    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push("<h" + level + ">" + inline(heading[2].replace(/\s+#+\s*$/, "")) + "</h" + level + ">");
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      flush();
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote>" + renderMarkdown(quote.join("\n")) + "</blockquote>");
      continue;
    }

    if (isTableStart(lines, i)) {
      flush();
      const head = splitRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      let html = '<div class="table-wrap"><table><thead><tr>';
      for (const cell of head) html += "<th>" + inline(cell) + "</th>";
      html += "</tr></thead><tbody>";
      for (const row of rows) {
        html += "<tr>";
        for (let c = 0; c < head.length; c += 1) html += "<td>" + inline(row[c] ?? "") + "</td>";
        html += "</tr>";
      }
      html += "</tbody></table></div>";
      out.push(html);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const baseIndent = indentOf(line);
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        const current = lines[i];
        const match = current.match(/^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!match) break;
        const indent = match[1].replace(/\t/g, "  ").length;
        if (indent < baseIndent) break;
        if (indent === baseIndent) {
          items.push({ text: match[3], nested: [] });
          i += 1;
          continue;
        }
        if (!items.length) break;
        items[items.length - 1].nested.push(current.slice(baseIndent + 2));
        i += 1;
      }
      const tag = ordered ? "ol" : "ul";
      let html = "<" + tag + ">";
      for (const item of items) {
        const text = checkboxify(inline(item.text));
        html += "<li>" + text;
        if (item.nested.length) html += renderMarkdown(item.nested.join("\n"));
        html += "</li>";
      }
      html += "</" + tag + ">";
      out.push(html);
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flush();
  return out.join("");
}
