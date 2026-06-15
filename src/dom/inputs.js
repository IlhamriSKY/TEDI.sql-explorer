// SQL Explorer — dom/inputs: form controls (text/number/checkbox/search) +
// cryptoId. Bundled by build.mjs.
import { el } from "./element.js";
import { appendIcon } from "./icon.js";

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

export function checkbox(checked, onChange) {
  const node = el("input", { class: "tsql-checkbox", attrs: { type: "checkbox" } });
  node.checked = !!checked;
  if (onChange) node.addEventListener("change", () => onChange(node.checked));
  return node;
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
