// SQL Explorer — styles barrel. Bundled into extension.js by build.mjs.
//
// Single <style> block; class names all start with `tsql-` so they don't
// collide with TEDI host styles. Colours pull from TEDI's design tokens via
// CSS variables, so the panel inherits dark/light themes automatically. The CSS
// is split into themed chunks for navigation and concatenated here IN ORDER so
// the cascade is byte-for-byte the same as one stylesheet:
//   layout   — shell, toolbar, editor + splitter, result scaffolding
//   grid     — result/table grids, typed cell editors, pager
//   controls — dialogs, forms, select/context menus, tooltip, responsive
import { LAYOUT_CSS } from "./styles/layout.js";
import { GRID_CSS } from "./styles/grid.js";
import { CONTROLS_CSS } from "./styles/controls.js";

const STYLE_ID = "tsql-styles";
const STYLES_CSS = [LAYOUT_CSS, GRID_CSS, CONTROLS_CSS].join("\n");

export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES_CSS;
  document.head.appendChild(style);
}
