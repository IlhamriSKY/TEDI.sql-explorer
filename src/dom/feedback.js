// SQL Explorer — dom/feedback: toast + clipboard helpers. Bundled by build.mjs.
import { ctx } from "../runtime.js";

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
