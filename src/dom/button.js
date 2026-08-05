// SQL Explorer — dom/button: the icon+label button. Bundled by build.mjs.
import { el } from "./element.js";
import { appendIcon } from "./icon.js";

/** Button with a HugeIcon on the left and a text label. The icon is the
 *  same chrome class TEDI core's header buttons use (size 13, stroke 1.75).
 *
 *  `opts.iconOnly` drops the label and squares the button off, for a dense
 *  toolbar where the glyphs are already unambiguous. `text` is still required:
 *  with no visible label it becomes the accessible name, and `opts.title` (which
 *  `el` rewrites to `data-tooltip`) is what a sighted user reads on hover. An
 *  icon-only button with neither would be unlabelled in both senses. */
export function textBtn(text, iconName, opts = {}) {
  const cls = `tsql-btn${opts.iconOnly ? " tsql-btn--icon" : ""}${opts.primary ? " is-primary" : ""}${opts.disabled ? " is-disabled" : ""}`;
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
  if (opts.iconOnly) return btn;
  // Wrap the label in a span so CSS `gap` treats it as a flex child.
  // A bare text node is anonymous inline content and falls outside the
  // gap algorithm, which is why icon+label looked glued together.
  const label = document.createElement("span");
  label.textContent = text;
  btn.appendChild(label);
  return btn;
}
