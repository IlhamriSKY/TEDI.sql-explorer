// SQL Explorer — dom module. Bundled into extension.js by build.mjs.
import { ctx } from "./runtime.js";


// ----------------------------- DOM helpers -----------------------------------

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

/**
 * Append a HugeIcon to `parent` via ctx.ui.icon. Tolerates older TEDI
 * hosts that pre-date the icon API by rendering a tiny placeholder so
 * the layout stays stable instead of jumping when buttons lose chrome.
 */
export function appendIcon(parent, iconName, opts = {}) {
  if (!parent) return;
  const size = opts.size ?? 14;
  try {
    if (ctx?.ui?.icon) {
      parent.appendChild(ctx.ui.icon(iconName, { size, strokeWidth: 1.75, ...opts }));
      return;
    }
  } catch (err) {
    ctx?.logger?.warn?.("icon mount failed", iconName, err);
  }
  const placeholder = document.createElement("span");
  placeholder.style.display = "inline-block";
  placeholder.style.width = `${size}px`;
  placeholder.style.height = `${size}px`;
  parent.appendChild(placeholder);
}

export function safeToast(message, variant) {
  try {
    ctx?.ui?.toast(message, { variant });
  } catch {
    ctx?.logger?.info?.(message);
  }
}

/** Copy text to the clipboard with a confirmation toast. Used by the grid
 *  copy actions (copy cell / row / row-as-INSERT). */
export async function copyToClipboard(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    safeToast(label, "success");
  } catch (err) {
    ctx?.logger?.warn?.("clipboard write failed", err);
    safeToast("Copy failed (clipboard unavailable)", "error");
  }
}

/** Plain-text form of a grid cell value for clipboard/TSV copy. NULL → empty
 *  (so pasted cells stay blank), bytes → empty (no client-side payload),
 *  objects → compact JSON, everything else stringified. */
export function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.__type === "bytes") return "";
    return JSON.stringify(value);
  }
  return String(value);
}

/** Set (or clear) the custom-tooltip text on a node. Mirrors a `title`
 *  attribute but routes through the styled tooltip layer instead of the
 *  OS-native bubble. Empty / null clears it. Used for the many cell tds
 *  whose tooltip is assigned imperatively after creation. */
export function setTooltipAttr(node, text) {
  if (!node) return;
  if (text == null || text === "") node.removeAttribute("data-tooltip");
  else node.setAttribute("data-tooltip", String(text));
}

// ----------------------------- Tooltip layer ---------------------------------
// A single delegated tooltip controller. Native `title` attributes render
// the OS bubble, which clashes with TEDI's chrome; every `title` in this
// extension is rewritten to `data-tooltip` (see el() + setTooltipAttr) and
// surfaced here as a styled popover that mirrors the host's Radix
// TooltipContent (rounded popover, 1px ring, soft shadow, 11px text, 200 ms
// hover delay, fade/zoom in). One reused bubble node, positioned with the
// same prefer-top / flip-to-bottom / clamp-to-viewport logic.
const TOOLTIP_DELAY_MS = 200;
const TOOLTIP_OFFSET = 6; // matches host tooltip sideOffset
const TOOLTIP_PAD = 8; // matches host tooltip collisionPadding
export let tooltipLayer = null;

export function initTooltipLayer(root) {
  if (!root) return null;
  let bubble = null;
  let showTimer = null;
  let current = null;

  const ensureBubble = () => {
    if (!bubble || !bubble.isConnected) {
      bubble = document.createElement("div");
      bubble.className = "tsql-tooltip";
      bubble.setAttribute("role", "tooltip");
      document.body.appendChild(bubble);
    }
    return bubble;
  };

  const place = (target) => {
    const tip = ensureBubble();
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer above the target; flip below if it would clip the top edge.
    let top = r.top - th - TOOLTIP_OFFSET;
    let side = "top";
    if (top < TOOLTIP_PAD) {
      top = r.bottom + TOOLTIP_OFFSET;
      side = "bottom";
    }
    if (side === "bottom" && top + th > vh - TOOLTIP_PAD && r.top - th - TOOLTIP_OFFSET >= TOOLTIP_PAD) {
      top = r.top - th - TOOLTIP_OFFSET;
      side = "top";
    }
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(TOOLTIP_PAD, Math.min(left, vw - tw - TOOLTIP_PAD));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.dataset.side = side;
  };

  const show = (target) => {
    const text = target.getAttribute("data-tooltip");
    if (!text) return;
    const tip = ensureBubble();
    tip.textContent = text;
    tip.style.visibility = "hidden";
    tip.classList.add("is-open");
    // Measure first (visibility:hidden keeps it laid out), then position.
    place(target);
    tip.style.visibility = "";
  };

  const hide = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    current = null;
    if (bubble) bubble.classList.remove("is-open");
  };

  const onOver = (event) => {
    const target = event.target?.closest?.("[data-tooltip]");
    if (!target || target === current || !root.contains(target)) return;
    current = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (current === target && target.isConnected) show(target);
    }, TOOLTIP_DELAY_MS);
  };
  const onOut = (event) => {
    if (!current) return;
    const target = event.target?.closest?.("[data-tooltip]");
    if (target !== current) return;
    // Ignore moves that stay inside the same tooltip owner.
    if (event.relatedTarget && target.contains(event.relatedTarget)) return;
    hide();
  };
  const onFocusIn = (event) => {
    const target = event.target?.closest?.("[data-tooltip]");
    if (!target || !root.contains(target)) return;
    current = target;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (current === target && target.isConnected) show(target);
    }, TOOLTIP_DELAY_MS);
  };

  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerout", onOut);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", hide);
  // A click / scroll / wheel can detach the hovered node or move it out from
  // under the bubble; drop the tooltip immediately so it never floats orphaned.
  root.addEventListener("pointerdown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("wheel", hide, { capture: true, passive: true });

  return {
    dispose() {
      hide();
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerout", onOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide, { capture: true });
      bubble?.remove();
      bubble = null;
    },
  };
}

/** Remove any open modal overlays. They live on document.body so they can
 *  outlive a `panelRoot` rebuild; this clears them when the pane/extension is
 *  torn down so a dialog never lingers after its SQL Explorer is gone. */
/**
 * Open `select()` dropdown menus, tracked by their `closeMenu` closure. A menu
 * is appended to <body> and adds capture-phase document listeners; if its
 * trigger is detached while open (grid re-render, pane teardown) the normal
 * click/Escape close never fires, so we close them explicitly from here.
 */
const openSelectMenus = new Set();

export function closeAllSelectMenus() {
  for (const close of [...openSelectMenus]) {
    try {
      close();
    } catch {
      /* ignore */
    }
  }
}

// Builds a search input with a HugeIcon clear (X) button overlaid on the
// right. Browser's native `type=search` clear button paints in the user's
// system colour and doesn't match the host icon family, so we use a
// `type=text` input + an absolutely-positioned button that shares the
// HugeIcon palette with textBtn / row actions. The clear
// button hides while the input is empty (no useless X glyph) and shows
// the moment the user types one character.
export function makeSearchInput({
  placeholder,
  ariaLabel,
  inputClass = "",
  wrapClass = "",
  initialValue = "",
  onInput,
}) {
  const wrap = el("div", { class: `tsql-search-wrap ${wrapClass}`.trim() });
  const input = el("input", {
    class: inputClass,
    attrs: {
      type: "text",
      placeholder,
      "aria-label": ariaLabel,
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  input.value = initialValue;
  const clearBtn = el("button", {
    class: "tsql-search-clear",
    attrs: {
      type: "button",
      "aria-label": "Clear search",
      title: "Clear",
      tabindex: "-1",
    },
  });
  appendIcon(clearBtn, "Cancel01Icon", { size: 12 });
  const sync = () => {
    clearBtn.classList.toggle("is-visible", Boolean(input.value));
  };
  sync();
  input.addEventListener("input", () => {
    sync();
    onInput?.(input.value);
  });
  clearBtn.addEventListener("click", () => {
    if (!input.value) return;
    input.value = "";
    sync();
    onInput?.("");
    input.focus();
  });
  wrap.appendChild(input);
  wrap.appendChild(clearBtn);
  return { wrap, input };
}


export function cryptoId() {
  if (globalThis.crypto?.randomUUID) return `c-${globalThis.crypto.randomUUID()}`;
  return `c-${Math.random().toString(36).slice(2, 10)}`;
}

export function input({ type = "text", value = "", onInput, placeholder } = {}) {
  const node = el("input", {
    class: "tsql-input",
    attrs: { type, placeholder },
  });
  node.value = value ?? "";
  if (onInput) node.addEventListener("input", () => onInput(node.value));
  return node;
}

/** A `type="number"` input wrapped with themed up/down steppers (see
 *  makeNumberWrap). Returns the wrapper element; the `onInput` listener fires
 *  for both typing and stepper clicks. Used for the connection editor's
 *  numeric fields so they match the cell editor's number chrome. */
export function numberInput({ value = "", onInput, min, step, placeholder } = {}) {
  const node = input({ type: "number", value, onInput, placeholder });
  if (min != null) node.setAttribute("min", String(min));
  if (step != null) node.setAttribute("step", String(step));
  return makeNumberWrap(node);
}

/**
 * Text-only dropdown that mirrors TEDI's Settings DropdownMenu (shadcn /
 * radix-luma): outline trigger with an ArrowDown01Icon caret, rounded
 * popup rendered into `document.body`, Tick02Icon next to the selected
 * item, click-outside + Escape to close. No per-option icons by design
 * so the workbench stays compact and reads as part of TEDI's chrome.
 *
 * Returns the trigger element. The signature matches the old native-
 * `<select>` helper so we can drop it in without changing callers.
 */
export function select(options, current, onChange) {
  let value = current;
  let menu = null;
  let isOpen = false;

  const trigger = el("button", {
    class: "tsql-select",
    attrs: {
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
    },
  });

  const labelSpan = el("span", { class: "tsql-select-label" });
  trigger.appendChild(labelSpan);

  const caretBox = el("span", { class: "tsql-select-caret" });
  appendIcon(caretBox, "ArrowDown01Icon", { size: 12, strokeWidth: 2 });
  trigger.appendChild(caretBox);

  const updateLabel = () => {
    const current = options.find((o) => o.value === value);
    labelSpan.textContent = current?.label ?? "";
  };
  updateLabel();

  const onDocMouseDown = (event) => {
    if (!menu) return;
    if (menu.contains(event.target) || trigger.contains(event.target)) return;
    closeMenu();
  };
  const onDocKeyDown = (event) => {
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  };

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    openSelectMenus.delete(closeMenu);
  }

  function openMenu() {
    if (isOpen) return;
    const rect = trigger.getBoundingClientRect();
    menu = el("ul", {
      class: "tsql-select-menu",
      attrs: { role: "listbox" },
    });
    menu.style.position = "fixed";
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.minWidth = `${Math.max(rect.width, 200)}px`;
    menu.style.zIndex = "10000";

    for (const opt of options) {
      const item = el("li", {
        class: `tsql-select-item${opt.value === value ? " is-selected" : ""}`,
        attrs: { role: "option", "data-value": opt.value },
      });
      item.appendChild(el("span", { class: "tsql-select-item-label", text: opt.label }));
      if (opt.value === value) {
        const check = el("span", { class: "tsql-select-item-check" });
        appendIcon(check, "Tick02Icon", { size: 13, strokeWidth: 2 });
        item.appendChild(check);
      }
      item.addEventListener("click", () => {
        value = opt.value;
        if (onChange) {
          try {
            onChange(opt.value);
          } catch (err) {
            ctx?.logger?.error?.("dropdown onChange threw", err);
          }
        }
        updateLabel();
        closeMenu();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    trigger.setAttribute("aria-expanded", "true");
    isOpen = true;
    openSelectMenus.add(closeMenu);
    // Defer listener attach so the click that opened us doesn't immediately close.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("keydown", onDocKeyDown, true);
    });
  }

  trigger.addEventListener("click", () => {
    if (isOpen) closeMenu();
    else openMenu();
  });
  return trigger;
}

/**
 * Show a right-click context menu at the pointer. `items` is a list of
 * `{ label, icon?, onClick }` (or `{ separator: true }`). The menu mounts on
 * <body>, clamps to the viewport, and closes on click-away / Escape / scroll;
 * its closer is registered with the shared floating-menu set so teardown and
 * grid re-renders clean it up too.
 */
export function openContextMenu(event, items) {
  event.preventDefault();
  closeAllSelectMenus();
  const menu = el("ul", { class: "tsql-context-menu", attrs: { role: "menu" } });
  menu.style.position = "fixed";
  menu.style.zIndex = "10000";

  const onDocMouseDown = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onDocKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const onScroll = () => close();
  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    openSelectMenus.delete(close);
  }

  for (const it of items) {
    if (it.separator) {
      menu.appendChild(el("li", { class: "tsql-context-sep", attrs: { role: "separator" } }));
      continue;
    }
    const li = el("li", { class: "tsql-context-item", attrs: { role: "menuitem" } });
    if (it.icon) {
      const ico = el("span", { class: "tsql-context-icon" });
      appendIcon(ico, it.icon, { size: 13, strokeWidth: 2 });
      li.appendChild(ico);
    }
    li.appendChild(el("span", { class: "tsql-context-label", text: it.label }));
    li.addEventListener("click", () => {
      close();
      try {
        it.onClick();
      } catch (err) {
        ctx?.logger?.error?.("context-menu action threw", err);
      }
    });
    menu.appendChild(li);
  }

  document.body.appendChild(menu);
  // Clamp to the viewport so an edge click doesn't push the menu off-screen.
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const x = Math.min(event.clientX, window.innerWidth - mw - 8);
  const y = Math.min(event.clientY, window.innerHeight - mh - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  openSelectMenus.add(close);
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
  });
}

export function checkbox(checked, onChange) {
  const node = el("input", { class: "tsql-checkbox", attrs: { type: "checkbox" } });
  node.checked = !!checked;
  if (onChange) node.addEventListener("change", () => onChange(node.checked));
  return node;
}

// ----------------------------- Editor + results ------------------------------

/** Button with a HugeIcon on the left and a text label. The icon is the
 *  same chrome class TEDI core's header buttons use (size 13, stroke 1.75). */
export function textBtn(text, iconName, opts = {}) {
  const cls = `tsql-btn${opts.primary ? " is-primary" : ""}${opts.disabled ? " is-disabled" : ""}`;
  const btn = el("button", {
    class: cls,
    attrs: {
      type: "button",
      title: opts.title,
      "aria-label": opts.title ?? text,
      disabled: opts.disabled ? "true" : undefined,
    },
    on: opts.onClick ? { click: opts.onClick } : undefined,
  });
  if (iconName) appendIcon(btn, iconName, { size: 13 });
  // Wrap the label in a span so CSS `gap` treats it as a flex child.
  // A bare text node is anonymous inline content and falls outside the
  // gap algorithm, which is why icon+label looked glued together.
  const label = document.createElement("span");
  label.textContent = text;
  btn.appendChild(label);
  return btn;
}

/**
 * Wrap a `<input type="number">` in a container with themed up/down stepper
 * buttons. The native WebView2 spin button renders light-on-dark and clashes
 * with the workbench chrome, so it's hidden in CSS and replaced here. Buttons
 * preventDefault on mousedown to keep focus on the input (so an inline cell
 * editor's blur-commit doesn't fire mid-step), step the value via the native
 * stepUp/stepDown, then dispatch `input` so any onInput listener stays in sync.
 */
export function makeNumberWrap(editor) {
  const wrap = el("div", { class: "tsql-num" });
  wrap.appendChild(editor);
  const steps = el("div", { class: "tsql-num-steps" });
  const makeStep = (dir, iconName, label) => {
    const btn = el("button", {
      class: "tsql-num-step",
      attrs: { type: "button", tabindex: "-1", "aria-label": label },
    });
    appendIcon(btn, iconName, { size: 9, strokeWidth: 2.5 });
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      try {
        if (dir > 0) editor.stepUp();
        else editor.stepDown();
      } catch {
        // stepUp/stepDown throws when the field is empty / non-numeric;
        // seed a sensible first step instead.
        editor.value = dir > 0 ? "1" : "-1";
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.focus();
    });
    return btn;
  };
  steps.appendChild(makeStep(1, "ArrowUp01Icon", "Increment"));
  steps.appendChild(makeStep(-1, "ArrowDown01Icon", "Decrement"));
  wrap.appendChild(steps);
  return wrap;
}

export function setTooltipLayer(value) {
  tooltipLayer = value;
}
