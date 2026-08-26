// SQL Explorer — dom/menus: the custom <select> dropdown + right-click context
// menu. Both mount on <body> and share the floating-menu registry so a detached
// trigger (grid re-render / pane teardown) can still be force-closed. Bundled by
// build.mjs.
import { ctx } from "../runtime.js";
import { el } from "./element.js";
import { appendIcon } from "./icon.js";

/**
 * Open `select()` dropdown + context menus, tracked by their `closeMenu`
 * closure. A menu is appended to <body> and adds capture-phase document
 * listeners; if its trigger is detached while open (grid re-render, pane
 * teardown) the normal click/Escape close never fires, so we close them
 * explicitly from here.
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

/**
 * Place a body-mounted floating layer (a menu, a picker popup) inside the
 * viewport.
 *
 * `anchor` is either a DOMRect to hang below — flipping above when there is no
 * room underneath — or an `{x, y}` point to open at, for a right-click. Every
 * floating layer here used to do this by hand and differently, and the select
 * menu did not clamp at all: near the bottom of a short pane it opened partly
 * off-screen.
 */
export function placeFloating(node, anchor, { gap = 4, margin = 8 } = {}) {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const anchored = typeof anchor.bottom === "number";
  let left = anchored ? anchor.left : anchor.x;
  let top = anchored ? anchor.bottom + gap : anchor.y;
  if (anchored && top + h > window.innerHeight - margin && anchor.top - h - gap > margin) {
    top = anchor.top - h - gap;
  } else {
    top = Math.min(top, window.innerHeight - h - margin);
  }
  left = Math.min(left, window.innerWidth - w - margin);
  node.style.left = `${Math.max(margin, left)}px`;
  node.style.top = `${Math.max(margin, top)}px`;
}

/**
 * Register an arbitrary floating-popup closer (e.g. the custom date picker)
 * with the same registry the select/context menus use, so a grid re-render or
 * pane teardown (`closeAllSelectMenus()`) force-closes it too instead of
 * orphaning a body-mounted popup. Returns an unregister fn.
 */
export function trackFloatingMenu(closeFn) {
  openSelectMenus.add(closeFn);
  return () => openSelectMenus.delete(closeFn);
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
 *
 * `opts.className` adds classes to the trigger; `opts.onDismiss` fires when the
 * menu closes WITHOUT a pick (outside-click / Escape / programmatic close) —
 * used by the inline cell editor to revert when the user dismisses the dropdown
 * without choosing. Both are optional, so existing 3-arg callers are unchanged.
 *
 * `opts.searchable` puts a filter box at the top of the popup and focuses it on
 * open, matching the host's own saved-host picker (the SSH dialog's jump host is
 * a cmdk combobox). Options may carry a `keywords` string so a host is findable
 * by `user@host:port` and not just by the name shown on the row.
 */
export function select(options, current, onChange, opts = {}) {
  let value = current;
  let menu = null;
  let isOpen = false;
  let picked = false;

  const trigger = el("button", {
    class: `tsql-select${opts.className ? ` ${opts.className}` : ""}`,
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
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
    } else if (event.key === "Tab") {
      // Tab dismisses the dropdown (and fires onDismiss so an inline cell editor
      // reverts) instead of leaving an orphaned open menu; don't preventDefault
      // so focus still moves naturally.
      closeMenu();
    }
  };
  // The pane (.tsql-host) is now scrollable, so a scroll would leave this
  // body-mounted menu floating at stale coordinates — close it on any scroll
  // (capture, to catch the pane / grid scroll), matching openContextMenu.
  const onDocScroll = () => closeMenu();

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("scroll", onDocScroll, true);
    openSelectMenus.delete(closeMenu);
    // Closed without a pick (outside-click / Escape / forced close) → let the
    // caller (e.g. an inline cell editor) revert.
    if (!picked && opts.onDismiss) {
      try {
        opts.onDismiss();
      } catch (err) {
        ctx?.logger?.error?.("dropdown onDismiss threw", err);
      }
    }
  }

  function openMenu() {
    if (isOpen) return;
    picked = false;
    const rect = trigger.getBoundingClientRect();
    menu = el("ul", {
      class: "tsql-select-menu",
      attrs: { role: "listbox" },
    });
    menu.style.position = "fixed";
    menu.style.minWidth = `${Math.max(rect.width, 200)}px`;
    menu.style.zIndex = "10000";

    // Filter box. Rows are built once and hidden/shown, so a pick keeps working
    // through whatever is on screen and there is no re-render to lose focus to.
    const rows = [];
    let searchInput = null;
    let emptyRow = null;
    if (opts.searchable) {
      const head = el("li", { class: "tsql-select-search", attrs: { role: "presentation" } });
      // Glyph + borderless input inside one filled box, matching the host's
      // CommandInput. The icon is decorative: the input carries the aria-label.
      const box = el("div", { class: "tsql-select-search-box" });
      const icon = el("span", { class: "tsql-select-search-icon", attrs: { "aria-hidden": "true" } });
      appendIcon(icon, "lucide:Search", { size: 12, strokeWidth: 2 });
      searchInput = el("input", {
        attrs: {
          type: "text",
          placeholder: opts.searchPlaceholder ?? "Search…",
          "aria-label": opts.searchPlaceholder ?? "Search",
          autocomplete: "off",
          spellcheck: "false",
        },
      });
      box.appendChild(icon);
      box.appendChild(searchInput);
      head.appendChild(box);
      menu.appendChild(head);
      emptyRow = el("li", { class: "tsql-select-empty", text: "No match." });
    }
    const applyFilter = () => {
      const q = (searchInput?.value ?? "").trim().toLowerCase();
      let shown = 0;
      for (const { item, haystack } of rows) {
        const hit = !q || haystack.includes(q);
        item.style.display = hit ? "" : "none";
        if (hit) shown++;
      }
      if (emptyRow) emptyRow.style.display = shown === 0 ? "" : "none";
    };

    for (const opt of options) {
      const item = el("li", {
        class: `tsql-select-item${opt.value === value ? " is-selected" : ""}`,
        attrs: { role: "option", "data-value": opt.value },
      });
      rows.push({ item, haystack: `${opt.label} ${opt.keywords ?? ""}`.toLowerCase() });
      item.appendChild(el("span", { class: "tsql-select-item-label", text: opt.label }));
      if (opt.value === value) {
        const check = el("span", { class: "tsql-select-item-check" });
        appendIcon(check, "Tick02Icon", { size: 13, strokeWidth: 2 });
        item.appendChild(check);
      }
      item.addEventListener("click", () => {
        value = opt.value;
        picked = true;
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
    if (emptyRow) {
      menu.appendChild(emptyRow);
      applyFilter();
    }
    if (searchInput) {
      searchInput.addEventListener("input", applyFilter);
      searchInput.addEventListener("keydown", (e) => {
        // Enter takes the first row still on screen, so a filter that narrows to
        // one host is pickable without reaching for the mouse. Escape and Tab
        // stay with the document handler that closes the menu.
        if (e.key !== "Enter") return;
        e.preventDefault();
        rows.find((r) => r.item.style.display !== "none")?.item.click();
      });
    }

    document.body.appendChild(menu);
    placeFloating(menu, rect);
    trigger.setAttribute("aria-expanded", "true");
    isOpen = true;
    openSelectMenus.add(closeMenu);
    // Focus AFTER mounting; an unattached input cannot take focus.
    searchInput?.focus();
    // Defer listener attach so the click that opened us doesn't immediately close.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("keydown", onDocKeyDown, true);
      window.addEventListener("scroll", onDocScroll, true);
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
    // `danger: true` paints the row like the host's destructive ContextMenuItem
    // (red label + red glyph at rest, red-tinted bg on hover).
    const li = el("li", {
      class: `tsql-context-item${it.danger ? " is-danger" : ""}`,
      attrs: { role: "menuitem" },
    });
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
  placeFloating(menu, { x: event.clientX, y: event.clientY });

  openSelectMenus.add(close);
  requestAnimationFrame(() => {
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
  });
}
