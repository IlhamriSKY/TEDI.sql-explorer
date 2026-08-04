// SQL Explorer — dom/datePicker: a custom, theme-token date / time / datetime
// picker that replaces the native WebView2 control. The native popup can't be
// restyled (its rounded chips + selection are OS-drawn), so this one is built
// from plain DOM using the same chrome as the rest of the workbench: square
// corners (var(--radius, 0)), 1px var(--border) borders, --popover surface, and
// foreground/accent tokens — so it reads identically in dark and light mode.
// Bundled into extension.js by build.mjs.
import { el } from "./element.js";
import { appendIcon } from "./icon.js";
import { MONTHS, WEEKDAYS, formatState, pad2, parseState } from "./dateParts.js";
import { placeFloating, trackFloatingMenu } from "./menus.js";

export function createDatePicker({ type, value = "", onCommit, onCancel }) {
  let currentValue = value ?? "";
  let popup = null;
  let untrack = null;
  // View month shown in the calendar (independent of the selection so the user
  // can browse without changing the value).
  let view = (() => {
    const st = parseState(type, currentValue);
    return { y: st.y, mo: st.mo };
  })();

  const wrap = el("div", { class: `tsql-dp tsql-dp--${type}` });
  const input = el("input", {
    class: `tsql-input tsql-dp-input`,
    attrs: {
      type: "text",
      inputmode: type === "time" ? "numeric" : "text",
      placeholder: type === "date" ? "YYYY-MM-DD" : type === "time" ? "HH:MM:SS" : "YYYY-MM-DD HH:MM:SS",
      spellcheck: "false",
      autocomplete: "off",
    },
  });
  input.value = currentValue;
  const trigger = el("button", {
    class: "tsql-dp-trigger",
    attrs: { type: "button", tabindex: "-1", "aria-label": "Open picker" },
  });
  appendIcon(trigger, type === "time" ? "Clock01Icon" : "Calendar03Icon", { size: 14 });
  wrap.appendChild(input);
  wrap.appendChild(trigger);

  const getValue = () => input.value.trim();
  const setValue = (v) => {
    currentValue = v ?? "";
    input.value = currentValue;
  };

  // Typing is the source of truth; keep currentValue in sync.
  input.addEventListener("input", () => {
    currentValue = input.value;
  });

  function commit(v) {
    closePopup();
    if (onCommit) onCommit(v);
  }

  // Cancel: in the inline cell editor (onCancel set) this reverts the whole
  // edit in one keypress; in the insert dialog (no onCancel) it just closes the
  // popup. Routing Escape through here keeps the editor from lingering
  // half-mounted with a stale click-away listener.
  function dismiss() {
    closePopup();
    if (onCancel) onCancel();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (onCommit) {
        e.preventDefault();
        commit(getValue());
      }
    } else if (e.key === "Escape") {
      if (popup) {
        e.preventDefault();
        dismiss();
      } else if (onCancel) {
        e.preventDefault();
        onCancel();
      }
    } else if (e.key === "ArrowDown" && !popup) {
      e.preventDefault();
      openPopup();
    }
  });

  trigger.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
  trigger.addEventListener("click", () => (popup ? closePopup() : openPopup()));

  // ---- selection state, rebuilt from currentValue each time the popup opens --
  let sel = null;

  function syncInputFromSel() {
    // Only write a value once the state is "complete enough" so an untouched
    // empty cell stays empty (NULL). time is always complete; date needs a
    // day; datetime needs a day (time defaults to the current fields).
    if (type === "time" || sel.hasDate) {
      setValue(formatState(type, sel));
    }
  }

  function pickDay(y, mo, d) {
    sel.y = y;
    sel.mo = mo;
    sel.d = d;
    sel.hasDate = true;
    syncInputFromSel();
    if (type === "date") {
      commit(getValue());
    } else {
      renderPopupBody();
    }
  }

  function setTimePart(part, n) {
    sel[part] = n;
    sel.hasTime = true;
    if (type === "datetime" && !sel.hasDate) {
      // Adjusting the clock implies "today" for an as-yet-unpicked datetime.
      sel.hasDate = true;
    }
    syncInputFromSel();
  }

  function buildCalendar() {
    const box = el("div", { class: "tsql-dp-cal" });
    const head = el("div", { class: "tsql-dp-head" });
    const prev = el("button", { class: "tsql-dp-nav", attrs: { type: "button", "aria-label": "Previous month" } });
    appendIcon(prev, "ArrowLeft01Icon", { size: 15 });
    prev.addEventListener("click", () => {
      view.mo -= 1;
      if (view.mo < 0) { view.mo = 11; view.y -= 1; }
      renderPopupBody();
    });
    const next = el("button", { class: "tsql-dp-nav", attrs: { type: "button", "aria-label": "Next month" } });
    appendIcon(next, "ArrowRight01Icon", { size: 15 });
    next.addEventListener("click", () => {
      view.mo += 1;
      if (view.mo > 11) { view.mo = 0; view.y += 1; }
      renderPopupBody();
    });
    head.appendChild(prev);
    head.appendChild(el("span", { class: "tsql-dp-title", text: `${MONTHS[view.mo]} ${view.y}` }));
    head.appendChild(next);
    box.appendChild(head);

    const wk = el("div", { class: "tsql-dp-weekdays" });
    for (const w of WEEKDAYS) wk.appendChild(el("span", { class: "tsql-dp-wd", text: w }));
    box.appendChild(wk);

    const grid = el("div", { class: "tsql-dp-grid" });
    const startDow = new Date(view.y, view.mo, 1).getDay();
    const daysInMonth = new Date(view.y, view.mo + 1, 0).getDate();
    const today = new Date();
    for (let i = 0; i < startDow; i++) grid.appendChild(el("span", { class: "tsql-dp-day is-blank" }));
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = el("button", { class: "tsql-dp-day", attrs: { type: "button" }, text: String(d) });
      if (sel.hasDate && sel.y === view.y && sel.mo === view.mo && sel.d === d) {
        cell.classList.add("is-selected");
      }
      if (today.getFullYear() === view.y && today.getMonth() === view.mo && today.getDate() === d) {
        cell.classList.add("is-today");
      }
      cell.addEventListener("click", () => pickDay(view.y, view.mo, d));
      grid.appendChild(cell);
    }
    box.appendChild(grid);
    return box;
  }

  function buildTime() {
    const row = el("div", { class: "tsql-dp-time" });
    const field = (val, max, part) => {
      const f = el("input", {
        class: "tsql-input tsql-dp-time-field",
        attrs: { type: "text", inputmode: "numeric", maxlength: "2", "aria-label": part },
      });
      f.value = pad2(val);
      f.addEventListener("input", () => {
        f.value = f.value.replace(/\D/g, "").slice(0, 2);
      });
      f.addEventListener("change", () => {
        let n = parseInt(f.value || "0", 10);
        if (Number.isNaN(n)) n = 0;
        n = Math.min(max, Math.max(0, n));
        f.value = pad2(n);
        setTimePart(part, n);
      });
      return f;
    };
    row.appendChild(field(sel.hh, 23, "hh"));
    row.appendChild(el("span", { class: "tsql-dp-colon", text: ":" }));
    row.appendChild(field(sel.mi, 59, "mi"));
    row.appendChild(el("span", { class: "tsql-dp-colon", text: ":" }));
    row.appendChild(field(sel.ss, 59, "ss"));
    return row;
  }

  function buildFooter() {
    const foot = el("div", { class: "tsql-dp-footer" });
    const clear = el("button", { class: "tsql-btn tsql-dp-foot-btn", attrs: { type: "button" }, text: "Clear" });
    clear.addEventListener("click", () => {
      setValue("");
      commit("");
    });
    const nowBtn = el("button", {
      class: "tsql-btn tsql-dp-foot-btn",
      attrs: { type: "button" },
      text: type === "date" ? "Today" : "Now",
    });
    nowBtn.addEventListener("click", () => {
      const now = new Date();
      sel.y = now.getFullYear();
      sel.mo = now.getMonth();
      sel.d = now.getDate();
      sel.hh = now.getHours();
      sel.mi = now.getMinutes();
      sel.ss = now.getSeconds();
      sel.hasDate = true;
      sel.hasTime = true;
      view = { y: sel.y, mo: sel.mo };
      setValue(formatState(type, sel));
      commit(getValue());
    });
    const apply = el("button", {
      class: "tsql-btn is-primary tsql-dp-foot-btn",
      attrs: { type: "button" },
      text: "Apply",
    });
    apply.addEventListener("click", () => commit(getValue()));
    foot.appendChild(clear);
    const right = el("div", { class: "tsql-dp-foot-right" }, nowBtn, apply);
    foot.appendChild(right);
    return foot;
  }

  function renderPopupBody() {
    if (!popup) return;
    popup.replaceChildren();
    if (type !== "time") popup.appendChild(buildCalendar());
    if (type !== "date") popup.appendChild(buildTime());
    popup.appendChild(buildFooter());
  }

  const onDocMouseDown = (e) => {
    if (!popup) return;
    if (popup.contains(e.target) || wrap.contains(e.target)) return;
    closePopup();
  };
  // Keyboard dismissal that works whichever inner control has focus (text
  // input, a calendar day button, or an HH/MM/SS field — none of which carry
  // their own key handler). Capture-phase + stopPropagation so Escape/Enter
  // act on the popup first instead of bubbling to a surrounding modal/shortcut.
  const onDocKeyDown = (e) => {
    if (!popup) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit(getValue());
    }
  };

  function positionPopup() {
    if (popup) placeFloating(popup, wrap.getBoundingClientRect());
  }

  function openPopup() {
    if (popup) return;
    sel = parseState(type, getValue());
    view = { y: sel.y, mo: sel.mo };
    popup = el("div", { class: `tsql-dp-popup tsql-dp-popup--${type}` });
    popup.style.position = "fixed";
    popup.style.zIndex = "10000";
    popup.addEventListener("mousedown", (e) => {
      // Keep focus stuff sane: clicking inside shouldn't blur-commit the cell.
      if (e.target === popup) e.preventDefault();
    });
    document.body.appendChild(popup);
    renderPopupBody();
    positionPopup();
    untrack = trackFloatingMenu(closePopup);
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("keydown", onDocKeyDown, true);
    });
  }

  function closePopup() {
    if (!popup) return;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    popup.remove();
    popup = null;
    if (untrack) {
      try { untrack(); } catch { /* ignore */ }
      untrack = null;
    }
  }

  return {
    wrap,
    getValue,
    setValue,
    focus: () => {
      try { input.focus(); input.select(); } catch { /* ignore */ }
    },
    openPopup,
    closePopup,
    contains: (node) => wrap.contains(node) || (popup ? popup.contains(node) : false),
  };
}
