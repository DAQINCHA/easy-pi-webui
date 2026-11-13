import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public/styles.css"),
  "utf8",
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(^|,\\s*)" + escaped + "\\s*(,|{)", "m");
  const match = re.exec(CSS);
  assert.ok(match, "missing selector " + selector);
  const brace = CSS.indexOf("{", match.index);
  const end = CSS.indexOf("}", brace);
  assert.notEqual(brace, -1);
  assert.notEqual(end, -1);
  return CSS.slice(brace, end + 1);
}

function ruleGroupContains(selector, snippet) {
  // A selector may share a grouped rule; find the block that includes it.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    "[^{}]*" + escaped + "[^{}]*\\{[^}]*\\}",
    "g",
  );
  const blocks = CSS.match(re) || [];
  assert.ok(blocks.length, "missing rule group for " + selector);
  return blocks;
}

describe("menu selected contrast tokens", () => {
  it("defines inverted selected text tokens for both themes", () => {
    const dark = CSS.slice(CSS.indexOf('html[data-theme="dark"]'), CSS.indexOf('html[data-theme="light"]'));
    const light = CSS.slice(CSS.indexOf('html[data-theme="light"]'), CSS.indexOf("\n* {"));
    assert.match(dark, /--bg-selected:\s*#ffffff/);
    assert.match(dark, /--text-selected:\s*#000000/);
    assert.match(light, /--bg-selected:\s*#111111/);
    assert.match(light, /--text-selected:\s*#ffffff/);
    assert.match(light, /--text-selected-muted:/);
    assert.match(dark, /--text-selected-muted:/);
  });

  it("colors the selected label and check with --text-selected, not --text-1", () => {
    const active = rule(".menu-item.active");
    assert.match(active, /background:\s*var\(--bg-selected\)/);
    assert.match(active, /color:\s*var\(--text-selected\)/);
    assert.doesNotMatch(active, /var\(--text-1\)/);

    const labelBlocks = ruleGroupContains(".menu-item.active .mi-label", "");
    const joined = labelBlocks.join("\n");
    assert.match(joined, /\.menu-item\.active \.mi-label/);
    assert.match(joined, /\.menu-item\.active \.check/);
    assert.match(joined, /color:\s*var\(--text-selected\)/);
    assert.doesNotMatch(joined, /var\(--text-1\)/);
    assert.doesNotMatch(joined, /var\(--green\)/);
  });

  it("overrides explicit subtitle and badge colors on the selected item", () => {
    const blocks = ruleGroupContains(".menu-item.active .sub", "");
    const joined = blocks.join("\n");
    assert.match(joined, /\.menu-item\.active \.sub/);
    assert.match(joined, /\.menu-item\.active \.badge/);
    assert.match(joined, /color:\s*var\(--text-selected-muted\)/);
    assert.doesNotMatch(joined, /var\(--text-4\)/);
    // default unselected subtitle may still use --text-4
    assert.match(rule(".menu-item .sub"), /color:\s*var\(--text-4\)/);
  });

  it("uses black text on the yellow hover, including child labels", () => {
    const hoverBlocks = ruleGroupContains(".menu-item:hover .sub", "");
    const joined = hoverBlocks.join("\n");
    assert.match(joined, /\.menu-item:hover \.sub/);
    assert.match(joined, /\.menu-item:hover \.check/);
    assert.match(joined, /\.menu-item:hover \.mi-label/);
    assert.match(joined, /color:\s*var\(--accent-fg\)/);
  });

  it("keeps selected+hover and selected+focus as yellow with black child text", () => {
    const parent = ruleGroupContains(".menu-item.active:hover", "");
    assert.match(parent.join("\n"), /background:\s*var\(--bg-hover\)/);
    assert.match(parent.join("\n"), /color:\s*var\(--accent-fg\)/);
    const kids = ruleGroupContains(".menu-item.active:hover .sub", "");
    const joined = kids.join("\n");
    assert.match(joined, /\.menu-item\.active:hover \.sub/);
    assert.match(joined, /\.menu-item\.active:hover \.check/);
    assert.match(joined, /\.menu-item\.active:focus-visible \.sub/);
    assert.match(joined, /color:\s*var\(--accent-fg\)/);
  });

  it("does not let hover or selected styles override a disabled item", () => {
    const disabled = ruleGroupContains(".menu-item:disabled", "");
    const joined = disabled.join("\n");
    assert.match(joined, /color:\s*var\(--text-disabled\)/);
    const disabledHover = ruleGroupContains(".menu-item:disabled:hover", "");
    const hoverJoined = disabledHover.join("\n");
    assert.match(hoverJoined, /color:\s*var\(--text-disabled\)/);
    assert.match(hoverJoined, /background:\s*transparent/);
    assert.match(hoverJoined, /\.menu-item\.active:disabled/);
  });
});
