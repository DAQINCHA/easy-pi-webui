import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, resolveMarkdownFileHref, escapeHtml } from "../public/js/markdown.js";

describe("resolveMarkdownFileHref", () => {
  it("accepts relative and typical absolute file paths", () => {
    assert.equal(resolveMarkdownFileHref("./out/report.md"), "./out/report.md");
    assert.equal(resolveMarkdownFileHref("notes.txt"), "notes.txt");
    assert.equal(resolveMarkdownFileHref("/Users/demo/project/a.pdf"), "/Users/demo/project/a.pdf");
  });
  it("rejects javascript, mailto/https stay non-files, site paths stay site paths", () => {
    assert.equal(resolveMarkdownFileHref("javascript:alert(1)"), null);
    assert.equal(resolveMarkdownFileHref("https://example.com/a.md"), null);
    assert.equal(resolveMarkdownFileHref("/api/file?path=x"), null);
    assert.equal(resolveMarkdownFileHref("/styles.css"), null);
  });
});

describe("renderMarkdown file links", () => {
  it("turns local links into escaped data-ws-file anchors", () => {
    const html = renderMarkdown("请看 [报告](./out/a.md) 和 [外链](https://example.com/x)");
    assert.match(html, /data-ws-file="\.\/out\/a\.md"/);
    assert.match(html, /href="\/api\/file\?path=\.%2Fout%2Fa\.md&amp;mode=download"/);
    assert.match(html, /target="_blank"/);
    assert.doesNotMatch(html, /javascript:/);
  });
  it("escapes quotes in labels and paths", () => {
    const html = renderMarkdown('[x](./foo"onclick="alert(1))');
    assert.doesNotMatch(html, /\sonclick=/);
    assert.match(html, /data-ws-file="\.\/foo&quot;onclick=&quot;alert\(1"/);
    assert.match(html, /%22onclick%3D%22/);
  });
  it("preview helper escapes angle brackets", () => {
    assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
