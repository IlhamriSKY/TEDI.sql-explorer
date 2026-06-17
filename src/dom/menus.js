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

    document.body.appendChild(menu);
    trigger.setAttribute("aria-expanded", "true");
    isOpen = true;
    openSelectMenus.add(closeMenu);
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
