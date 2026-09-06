// SQL Explorer — styles/layout: the structural shell, toolbar, editor +
// splitter, and result-pane scaffolding. All classes are `tsql-`-prefixed and
// pull colours from TEDI's CSS design tokens. Bundled into extension.js by
// build.mjs. (Concatenated in order by styles.js — keep the cascade stable.)

export const LAYOUT_CSS = `
/* The pane is the vertical scroll container: when it gets shorter than the
   workbench's natural minimum height (toolbar + editor + results), it scrolls
   instead of clipping, so every control stays reachable.
   It is also the BENTO TRAY. It paints the deeper --sidebar well and insets its
   contents by 6px, so the toolbar, editor, action strip and results read as
   separate cards floating on it, with the same 6px seam the host puts between
   its own panes. Under glass the host pins this element to --tedi-glass-surface
   (globals.css), so the tray flattens there and the bento reads by card borders
   alone, exactly as it does for the host's own cards. */
.tsql-host { height: 100%; display: flex; flex-direction: column; color: var(--foreground); background: var(--sidebar, var(--background)); font-size: 12px; position: relative; overflow-y: auto; overflow-x: hidden; padding: 6px; }
/* min-height:100% (not height:100%): fills the pane when tall, but grows past
   it (so .tsql-host scrolls) when the content's natural min exceeds it. */
.tsql-root { display: flex; flex-direction: column; min-height: 100%; }
/* Pane surface (split-pane leaf): the host frame already supplies the header
   (title + drag + close) and the connection list lives in the host sidebar, so
   trim paddings for narrow pane widths and keep the workbench compact. */
.tsql-host--pane { font-size: 11.5px; }
.tsql-host--pane .tsql-toolbar { padding: 3px 6px; gap: 4px; }
.tsql-host--pane .tsql-result-meta { padding-top: 4px; padding-bottom: 4px; }

/* Single-column body: the editor + results stack. The connection → database →
   schema → table tree lives in the host's left "Databases" sidebar, so there
   is no in-pane sidebar or splitter here. */
/* Single-column body: grows to fill the root but never shrinks below its
   content (flex-shrink 0 + no min-height:0), so the workbench keeps its full
   height and the pane scrolls rather than squashing it. */
.tsql-body { display: flex; flex-direction: column; flex: 1 0 auto; min-width: 0; }
/* Connection root row: bolder label + a primary-tinted icon when active, and
   hover-revealed reload / edit / delete actions in the trailing grid cell. */
.tsql-row-action { width: 20px; height: 20px; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; border-radius: var(--radius, 0); display: inline-flex; align-items: center; justify-content: center; outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-row-action:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
/* Destructive variant for delete / trash row actions. Red AT REST (75%
   opacity so it doesn't shout in a list of neutral row actions), full
   --destructive on hover - matching the host's DESTRUCTIVE_ACTION
   (src/lib/toolbarButton.ts) used by Settings, WorkspacesPanel, the SSH
   menu and the extension sidebar rows. A delete has to be findable, and
   avoidable, before the pointer is on it. */
.tsql-row-action.is-danger { color: color-mix(in srgb, var(--destructive, #ef4444) 75%, transparent); }
.tsql-row-action.is-danger:hover { background: color-mix(in srgb, var(--destructive, #ef4444) 12%, transparent); color: var(--destructive, #ef4444); }
.tsql-row-action.is-danger:focus-visible { color: var(--destructive, #ef4444); outline: 1px solid var(--destructive, #ef4444); outline-offset: -1px; }

/* Sticky head holds the sidebar search input. Pinning the wrapper (not the
   children individually) keeps the input's horizontal margin gutters opaque
   so rows scrolling under it don't show through. */
/* Search input wrapper + HugeIcon clear (X) button. Replaces the native
   type=search browser X so it paints with the same currentColor + hover
   bg as the rest of the workbench icon row. The wrap is always
   position:relative so the absolutely-positioned X stays anchored
   to the input's right edge regardless of variant. */
.tsql-search-wrap { position: relative; display: block; box-sizing: border-box; }
.tsql-search-wrap--grid { display: inline-flex; align-items: center; width: 160px; vertical-align: middle; }
.tsql-search-wrap--grid > .tsql-input.tsql-grid-search { width: 100%; padding-right: 26px; }
.tsql-search-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; padding: 0; margin: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; display: none; align-items: center; justify-content: center; border-radius: var(--radius, 0); box-sizing: border-box; flex: 0 0 auto; z-index: 1; outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-search-clear.is-visible { display: inline-flex; }
.tsql-search-clear:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
.tsql-search-clear > svg, .tsql-search-clear > * { display: block; flex: 0 0 auto; pointer-events: none; }
/* No min-height:0 here: the workbench keeps its content-driven minimum height
   (so the pane scrolls when short) yet still flex-grows to fill a tall pane.
   .tsql-results / .tsql-grid-wrap keep min-height:0 for the grid's own scroll. */
.tsql-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.tsql-main--empty { align-items: center; justify-content: center; background: var(--background); border: 1px solid var(--border); border-radius: var(--radius, 0); }
/* Action toolbar (Run / Stop / Export + read-only pill) above the editor. A
   card on the tray: its old bottom hairline is gone, and the 6px margin below
   it is the seam to whatever comes next (editor, action strip or results). */
.tsql-toolbar { display: flex; gap: 5px; padding: 4px 8px; background: var(--card, var(--background)); flex-wrap: wrap; align-items: center; flex: 0 0 auto; border: 1px solid var(--border); border-radius: var(--radius, 0); margin-bottom: 6px; }
/* Buttons match the host's <Button variant="ghost"> chrome: 1 px
   transparent border at rest so the hover bg paints as a clean box
   without an outline ring, only --ring shows on focus-visible.
   .is-primary swaps to --primary/--primary-foreground for the Run
   action. Stays bg-transparent so the toolbar's card tint shows
   through; hover lifts to --muted. */
.tsql-btn { box-sizing: border-box; padding: 0 10px; height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: transparent; color: var(--foreground); cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 500; display: inline-flex; align-items: center; gap: 5px; line-height: 1; outline: none; transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease; }
.tsql-btn:hover:not([disabled]) { background: var(--muted, var(--accent, rgba(127,127,127,0.08))); color: var(--foreground); }
.tsql-btn:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
.tsql-btn.is-disabled, .tsql-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
/* Icon-only variant: square, no label. Same height as its labelled siblings so
   a toolbar mixing the two keeps one baseline. The name lives in aria-label +
   data-tooltip, never on screen. */
.tsql-btn--icon { width: 28px; padding: 0; justify-content: center; }
.tsql-dialog-form .tsql-btn--icon { width: 34px; }
/* Outline (secondary) button. The bare .tsql-btn is a GHOST - transparent bg
   AND a transparent border - which is right for a toolbar icon but leaves a
   dialog's Cancel reading as plain text with nothing to aim at. Anything in a
   modal footer that is not THE primary action wears this instead, so a footer
   reads as one filled action plus bordered alternatives rather than two
   identical blue buttons.

   A FILL now, reading the host's --tedi-button-face so it is the same neutral
   button the app draws. Safe to read, unlike its predecessor: the host holds
   the face to a contrast floor on load and pairs it with a label colour held to
   WCAG AA. The var() fallbacks cover an older host that defines neither. */
.tsql-btn.is-outline { background: var(--tedi-button-face, color-mix(in srgb, var(--foreground) 18%, transparent)); color: var(--tedi-button-face-foreground, var(--foreground)); border-color: transparent; }
.tsql-btn.is-outline:hover:not([disabled]) { background: var(--tedi-button-face-hover, color-mix(in srgb, var(--foreground) 28%, transparent)); }
.tsql-btn.is-primary { background: var(--primary, #3b82f6); color: var(--primary-foreground, #fff); border-color: transparent; }
.tsql-btn.is-primary:hover:not([disabled]) { background: color-mix(in srgb, var(--primary, #3b82f6) 80%, transparent); }
.tsql-btn.is-primary:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
/* Destructive confirm button. Mirrors the host's
   AlertDialogAction variant=destructive chrome: filled red bg
   with white text at rest, slightly lifted on hover, --ring on focus. */
.tsql-btn.is-destructive { background: var(--destructive, #ef4444); color: var(--destructive-foreground, #fff); border-color: transparent; }
.tsql-btn.is-destructive:hover:not([disabled]) { background: color-mix(in srgb, var(--destructive, #ef4444) 85%, transparent); }
.tsql-btn.is-destructive:focus-visible { border-color: var(--ring, var(--destructive, #ef4444)); }

/* Read-only badge in the query toolbar: signals the connection rejects writes
   (insert / edit / delete are all hidden). Mirrors the host <Badge> "secondary"
   variant (neutral, in-palette, pill geometry: h-5 / px-2 / py-0.5 / text-xs /
   font-medium) so it stays consistent with badges elsewhere in the app. Pushed
   to the right of the toolbar's action buttons. */
.tsql-ro-pill { margin-left: auto; box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 9999px; border: 1px solid transparent; font-size: 11px; font-weight: 500; line-height: 1; white-space: nowrap; cursor: default; color: var(--secondary-foreground, var(--foreground)); background: var(--secondary, var(--muted, rgba(127,127,127,0.16))); }
.tsql-ro-pill svg { width: 11px; height: 11px; flex: 0 0 auto; }

/* Code-editor container: hosts a CodeMirror EditorView mounted by
   ctx.ui.codeEditor. The .cm-editor inside fills the container. */
/* Compact fixed-basis editor (resizable via the splitter / --tsql-editor-h),
   shrinkable on short panes; the results below take all remaining space. */
.tsql-editor { width: 100%; min-height: 64px; overflow: hidden; display: flex; flex-direction: column; flex: 0 1 var(--tsql-editor-h, 128px); background: var(--background); border: 1px solid var(--border); border-radius: var(--radius, 0); }
.tsql-editor .cm-editor { height: 100%; flex: 1 1 auto; min-height: 0; }
.tsql-editor .cm-editor.cm-focused { outline: none; }
/* Vertical splitter between the query editor and the results pane.
   Drag handler in renderEditorAndResults updates --tsql-editor-h on
   the parent .tsql-main, which flex-basis: var(...) flows into.
   It paints NOTHING. Like the host's own ResizableHandle it simply IS the 6px
   seam between two cards, so the tray shows through and there is no line and no
   grip to look at. The ::after is a transparent hit pad, not paint: it reaches
   2px into the card above and below, so the grab target is the card's own edge.
   That is how the host handle behaves (its library inflates the hit region to
   10px around the gutter). The element stays rather than being deleted because
   it is a real role=separator with ARIA and arrow-key resize, so :focus-visible
   wears the host's outline recipe in place of the deleted line highlight.
   NB: comment lives in a JS template literal, so backticks are forbidden here. */
.tsql-splitter { position: relative; flex: 0 0 6px; cursor: ns-resize; background: transparent; user-select: none; touch-action: none; outline: none; }
.tsql-splitter::after { content: ""; position: absolute; left: 0; right: 0; top: -2px; bottom: -2px; }
.tsql-splitter:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary, #3b82f6) 70%, transparent); outline-offset: -2px; }
/* Fills all space below the compact editor (no gap), so the ≤10-row table
   uses the available height instead of scrolling inside a small box. */
/* No overflow:hidden here — it used to clip the bottom (pager/grid) AND cap the
   results' min-content at 96px, which broke the pane scroll. Without it, the
   results grow to their real content so the natural min propagates up and
   .tsql-host scrolls; the grid keeps its OWN internal scroll via .tsql-grid-wrap. */
.tsql-results { display: flex; flex-direction: column; min-height: 96px; flex: 1 1 auto; background: var(--background); border: 1px solid var(--border); border-radius: var(--radius, 0); }
.tsql-result-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px; background: var(--card, var(--background)); flex: 0 0 auto; }
.tsql-result-tab { padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 11px; transition: color 0.12s ease, background 0.12s ease; }
.tsql-result-tab:hover { color: var(--foreground); }
.tsql-result-tab.is-active { color: var(--foreground); border-color: var(--primary, #3b82f6); background: var(--accent, rgba(127,127,127,0.08)); }
/* Sizes to its content (no min-height:0 / no inner overflow) so a short pane
   scrolls via .tsql-host instead of spawning a second scrollbar here; the grid
   keeps its own internal scroll, and the result meta sticks to the pane top. */
.tsql-result-body { flex: 1 1 auto; padding: 0; display: flex; flex-direction: column; }
.tsql-result-meta { padding: 4px 10px; color: var(--muted-foreground); font-size: 11px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
/* Heidi-style result-grid toolbar: row-count + duration on the left,
   client-side search input + page navigation on the right. Wraps under
   the search on narrow widths so the controls never overlap.
   .tsql-meta--sticky pins the bar to the top of the scrolling result
   body so the user keeps the controls in view while scrolling. The
   1 px bottom divider matches the project's standard hairline. */
.tsql-grid-meta { justify-content: space-between; flex-wrap: wrap; gap: 5px 8px; padding: 4px 10px; row-gap: 4px; }
.tsql-grid-meta-left { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; }
.tsql-grid-meta-right { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.tsql-meta--sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--card, var(--background));
  border-bottom: 1px solid var(--border);
}
/* Small status pill rendered alongside the row count (e.g. "truncated"
   when the sidecar capped the result). Borrow the host's --warning
   palette so it reads as a soft amber tag, not an error. */
.tsql-tag { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 500; line-height: 1.4; }
.tsql-tag--warn { background: color-mix(in srgb, var(--tedi-icon-working, #f59e0b) 18%, transparent); color: var(--tedi-icon-working, #f59e0b); }
/* SQL preview strip above the grid so the user always sees the
   statement that produced the displayed rows. Single line with
   ellipsis; the full SQL is in the title attribute. Used as the
   fallback when ctx.ui.codeEditor is unavailable. */
.tsql-sql-preview { padding: 2px 12px 6px 12px; color: var(--muted-foreground); font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
/* Read-only, syntax-highlighted preview of the executed statement. Sizes
   to its content (auto-height CodeMirror) and caps tall multi-statement
   SQL with an internal scroll; the 1 px bottom hairline separates it from
   the result grid below. */
.tsql-sql-editor { flex: 0 0 auto; max-height: 108px; overflow: auto; border-bottom: 1px solid var(--border); background: var(--background); }
.tsql-sql-editor .cm-editor { height: auto; }
.tsql-sql-editor .cm-content { padding: 6px 0; }
/* Divider between the meta/search toolbar and the sticky table header
   so the two sections read as distinct bands instead of bleeding into
   each other. Border-top is dropped here because .tsql-meta--sticky
   already paints the 1 px hairline on its bottom edge, keeping the
   divider consistent across both result and table grids. */
.tsql-grid-slot { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 72px; }
.tsql-grid-slot > .tsql-grid-wrap { flex: 1 1 auto; }
`;
