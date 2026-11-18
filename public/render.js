export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name, extraClass = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "ico" + (extraClass ? " " + extraClass : ""));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "/assets/icons.svg#" + name);
  svg.append(use);
  return svg;
}

export function action(className, label, iconName, handler) {
  const button = el("button", className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", handler);
  return button;
}

const inlinePattern = /(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|(?<!\w)_[^_\n]+_(?!\w)|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function inline(target, text) {
  let index = 0;
  for (const match of text.matchAll(inlinePattern)) {
    target.append(text.slice(index, match.index));
    const token = match[0];
    if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const link = el("a", "", token.slice(1, split));
      link.href = token.slice(split + 2, -1);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      target.append(link);
    } else {
      const bold = token.startsWith("**") || token.startsWith("__");
      const size = bold ? 2 : 1;
      target.append(el(bold ? "strong" : token.charCodeAt(0) === 96 ? "code" : "em", "", token.slice(size, -size)));
    }
    index = match.index + token.length;
  }
  if (index < text.length) target.append(text.slice(index));
}

const fence = /^\s*(\x60{3,}|~{3,})(.*)$/;
const list = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)/;
const heading = /^\s*(#{1,6})\s+(.+)/;
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
}

export function markdown(text) {
  const content = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let at = 0;
  while (at < lines.length) {
    const line = lines[at++];
    if (!line.trim()) continue;
    const code = line.match(fence);
    if (code) {
      const body = [];
      while (at < lines.length && !lines[at].trimStart().startsWith(code[1])) body.push(lines[at++]);
      if (at < lines.length) at++;
      const pre = el("pre");
      pre.append(el("code", "", body.join("\n")));
      content.append(pre);
      continue;
    }
    if (line.includes("|") && tableRule.test(lines[at] || "")) {
      const wrapper = el("div", "table-wrap");
      const table = el("table");
      const row = (section, items, tag) => {
        const tr = el("tr");
        for (const value of items) { const cell = el(tag); inline(cell, value); tr.append(cell); }
        section.append(tr);
      };
      row(table.createTHead(), cells(line), "th");
      at++;
      const body = table.createTBody();
      while (at < lines.length && lines[at].includes("|") && lines[at].trim()) row(body, cells(lines[at++]), "td");
      wrapper.append(table);
      content.append(wrapper);
      continue;
    }
    const title = line.match(heading);
    if (title) {
      const node = el("h" + Math.min(title[1].length + 1, 4));
      inline(node, title[2]); content.append(node); continue;
    }
    const first = line.match(list);
    if (first) {
      const node = el(first[1] ? "ol" : "ul");
      if (first[1]) node.start = Number(first[1]);
      const addItem = value => { const item = el("li"); inline(item, value); node.append(item); };
      addItem(first[2]);
      while (at < lines.length) {
        const next = lines[at].match(list);
        if (!next || !!next[1] !== !!first[1]) break;
        addItem(next[2]); at++;
      }
      content.append(node); continue;
    }
    const quote = /^\s*>\s?/.test(line);
    const node = el(quote ? "blockquote" : "p");
    inline(node, quote ? line.replace(/^\s*>\s?/, "") : line);
    while (at < lines.length && lines[at].trim() && !fence.test(lines[at]) && !heading.test(lines[at]) && !list.test(lines[at]) &&
      /^\s*>\s?/.test(lines[at]) === quote && !(lines[at].includes("|") && tableRule.test(lines[at + 1] || ""))) {
      node.append(el("br"));
      inline(node, quote ? lines[at++].replace(/^\s*>\s?/, "") : lines[at++]);
    }
    content.append(node);
  }
  return content;
}
