// SQL Explorer — dom/element: hyperscript element builder. Bundled by build.mjs.

export function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.id) node.id = opts.id;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v == null || v === false) continue;
      // Route every `title` through the custom tooltip layer (data-tooltip)
      // instead of the OS-native browser bubble, so all SQL Explorer
      // tooltips paint with the host's rounded popover chrome. `aria-label`
      // (set alongside `title` on icon buttons) still carries the a11y name.
      const attrName = k === "title" ? "data-tooltip" : k;
      node.setAttribute(attrName, v === true ? "" : String(v));
    }
  }
  if (opts.style) Object.assign(node.style, opts.style);
  if (opts.on) {
    for (const [k, v] of Object.entries(opts.on)) {
      node.addEventListener(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      for (const inner of c) {
        if (inner == null || inner === false) continue;
        node.appendChild(inner instanceof Node ? inner : document.createTextNode(String(inner)));
      }
      continue;
    }
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
