// SQL Explorer — dom/tooltip: the single delegated tooltip layer + the
// data-tooltip attribute helper. Bundled by build.mjs.
//
// Native `title` attributes render the OS bubble, which clashes with TEDI's
// chrome; every `title` in this extension is rewritten to `data-tooltip` (see
// el() + setTooltipAttr) and surfaced here as a styled popover that mirrors the
// host's Radix TooltipContent (rounded popover, 1px ring, soft shadow, 11px
// text, 200 ms hover delay, fade/zoom in). One reused bubble node, positioned
// with the same prefer-top / flip-to-bottom / clamp-to-viewport logic.

/** Set (or clear) the custom-tooltip text on a node. Mirrors a `title`
 *  attribute but routes through the styled tooltip layer instead of the
 *  OS-native bubble. Empty / null clears it. Used for the many cell tds
 *  whose tooltip is assigned imperatively after creation. */
export function setTooltipAttr(node, text) {
  if (!node) return;
  if (text == null || text === "") node.removeAttribute("data-tooltip");
  else node.setAttribute("data-tooltip", String(text));
}

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

export function setTooltipLayer(value) {
  tooltipLayer = value;
}
