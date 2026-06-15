// SQL Explorer — styles module. Bundled into extension.js by build.mjs.

// ----------------------------- Styles ----------------------------------------
//
// Single <style> block; class names all start with `tsql-` so they don't
// collide with TEDI host styles. Colours pull from TEDI's design tokens via
// CSS variables, so the panel inherits dark/light themes automatically.

const STYLE_ID = "tsql-styles";
export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES_CSS;
  document.head.appendChild(style);
}

const STYLES_CSS = `
.tsql-host { height: 100%; display: flex; flex-direction: column; color: var(--foreground); background: var(--background); font-size: 12px; position: relative; }
.tsql-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
/* Pane surface (split-pane leaf): the host frame already supplies the header
   (title + drag + close) and the connection list lives in the host sidebar, so
   trim paddings for narrow pane widths and keep the workbench compact. */
.tsql-host--pane { font-size: 11.5px; }
.tsql-host--pane .tsql-toolbar { padding: 3px 6px; gap: 4px; }
.tsql-host--pane .tsql-result-meta { padding-top: 4px; padding-bottom: 4px; }

/* Single-column body: the editor + results stack. The connection → database →
   schema → table tree lives in the host's left "Databases" sidebar, so there
   is no in-pane sidebar or splitter here. */
.tsql-body { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }
/* Connection root row: bolder label + a primary-tinted icon when active, and
   hover-revealed reload / edit / delete actions in the trailing grid cell. */
.tsql-row-action { width: 20px; height: 20px; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; border-radius: var(--radius, 0); display: inline-flex; align-items: center; justify-content: center; outline: none; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-row-action:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
/* Destructive variant for delete / trash row actions. Rest sits at the
   same muted neutral as the regular action so the row doesn't scream
   "danger" until the user actually targets it; on hover the bg lifts
   to a 10% --destructive tint and the icon shifts to --destructive,
   matching the host's pattern (text-muted-foreground
   hover:bg-destructive/10 hover:text-destructive) used in Settings,
   WorkspacesPanel, ExplorerGrep, SSH menu, etc. */
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
.tsql-main { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.tsql-main--empty { align-items: center; justify-content: center; }
/* Action toolbar (Run / Stop / Export + read-only pill) above the editor. */
.tsql-toolbar { display: flex; gap: 5px; padding: 4px 8px; background: var(--card, var(--background)); flex-wrap: wrap; align-items: center; flex: 0 0 auto; border-bottom: 1px solid var(--border); }
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
.tsql-editor { width: 100%; min-height: 64px; overflow: hidden; display: flex; flex-direction: column; flex: 0 1 var(--tsql-editor-h, 150px); }
.tsql-editor .cm-editor { height: 100%; flex: 1 1 auto; min-height: 0; }
.tsql-editor .cm-editor.cm-focused { outline: none; }
/* Vertical splitter between the query editor and the results pane.
   Drag handler in renderEditorAndResults updates --tsql-editor-h on
   the parent .tsql-main, which flex-basis: var(...) flows into.
   Mirrors the host PaneTreeView's resize chrome (bg-border/50,
   hover bg-primary/50 on the line; thicker centred grip in
   --tedi-resize-handle) so the SQL Explorer splitter looks and feels
   identical to the terminal/editor pane separators. Grip is the
   "thicker section" the user sees in the middle of pane splits:
   24x4 sharp rectangle (radius-lg=0 in TEDI). NB: comment lives in
   a JS template literal, so backticks are forbidden here. */
.tsql-splitter { position: relative; flex: 0 0 6px; cursor: ns-resize; background: transparent; user-select: none; touch-action: none; outline: none; display: flex; align-items: center; justify-content: center; }
.tsql-splitter::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-50%); background: color-mix(in srgb, var(--border) 50%, transparent); transition: background 0.12s ease; }
.tsql-splitter::after { content: ""; position: relative; z-index: 1; width: 24px; height: 4px; background: var(--tedi-resize-handle, var(--border)); transition: background 0.12s ease; }
.tsql-splitter:hover::before, .tsql-splitter.is-dragging::before, .tsql-splitter:focus-visible::before { background: color-mix(in srgb, var(--primary, #3b82f6) 50%, transparent); }
.tsql-splitter:hover::after, .tsql-splitter.is-dragging::after, .tsql-splitter:focus-visible::after { background: var(--primary, #3b82f6); }
/* Fills all space below the compact editor (no gap), so the ≤10-row table
   uses the available height instead of scrolling inside a small box. */
.tsql-results { display: flex; flex-direction: column; min-height: 96px; overflow: hidden; flex: 1 1 auto; }
.tsql-result-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px; background: var(--card, var(--background)); flex: 0 0 auto; }
.tsql-result-tab { padding: 3px 8px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 11px; transition: color 0.12s ease, background 0.12s ease; }
.tsql-result-tab:hover { color: var(--foreground); }
.tsql-result-tab.is-active { color: var(--foreground); border-color: var(--primary, #3b82f6); background: var(--accent, rgba(127,127,127,0.08)); }
.tsql-result-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0; display: flex; flex-direction: column; }
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
.tsql-grid-slot { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.tsql-grid-slot > .tsql-grid-wrap { flex: 1 1 auto; }

/* Result / table grid: sticky header with a single 1px bottom hairline,
   zebra rows, no horizontal overflow surprise. */
.tsql-grid-wrap { overflow: auto; flex: 1 1 auto; min-height: 0; }
.tsql-grid-wrap.is-editable { border-top: 0; }
.tsql-grid { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 11px; }
.tsql-grid thead th { position: sticky; top: 0; background: var(--card, var(--background)); border-bottom: 1px solid var(--border); padding: 4px 9px; text-align: left; font-weight: 600; color: var(--muted-foreground); white-space: nowrap; z-index: 1; user-select: none; }
/* Sortable header: click cycles unset -> asc -> desc -> unset. The
   arrow span sits at the end of the cell; empty text reserves nothing
   so unsorted headers stay flush. */
.tsql-grid thead th.tsql-grid-th { cursor: pointer; transition: color 0.12s ease, background 0.12s ease; }
.tsql-grid thead th.tsql-grid-th:hover { color: var(--foreground); background: color-mix(in srgb, var(--foreground) 6%, var(--card, var(--background))); }
.tsql-grid thead th.tsql-grid-th.is-sort-asc, .tsql-grid thead th.tsql-grid-th.is-sort-desc { color: var(--foreground); }
.tsql-sort-arrow { display: inline-block; margin-left: 6px; font-size: 9px; line-height: 1; color: var(--muted-foreground); }
.tsql-grid-th.is-sort-asc .tsql-sort-arrow, .tsql-grid-th.is-sort-desc .tsql-sort-arrow { color: var(--foreground); }
/* Two-line header: name row (+ PK badge + sort arrow) over a muted type. */
.tsql-th-top { display: flex; align-items: center; gap: 5px; }
.tsql-th-name { overflow: hidden; text-overflow: ellipsis; }
.tsql-th-pk { flex-shrink: 0; font-size: 8.5px; font-weight: 700; letter-spacing: 0.04em; line-height: 1; padding: 1px 3px; border-radius: var(--radius, 0); color: var(--primary, #3b82f6); border: 1px solid color-mix(in srgb, var(--primary, #3b82f6) 45%, transparent); }
.tsql-th-type { display: block; margin-top: 2px; font-size: 9.5px; font-weight: 400; color: var(--muted-foreground); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; }
/* Toolbar search + column-filter controls. Sit ahead of the action
   buttons; widths are compact so the toolbar stays single-row on
   typical widths and wraps gracefully when narrow. The 28 px height
   matches the rest of the form chrome so search + filter + Row/Reload/
   Close buttons all sit on the same baseline. */
.tsql-input.tsql-grid-search { width: 100%; padding: 4px 26px 4px 10px; font-size: 11px; height: 28px; line-height: 1; box-sizing: border-box; }
.tsql-select.tsql-grid-colfilter { height: 28px; min-height: 28px; padding: 0 10px; font-size: 11px; max-width: 160px; min-width: 96px; }
.tsql-select.tsql-grid-colfilter .tsql-select-label { font-weight: normal; }
.tsql-grid tbody td { padding: 3px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
/* Zebra stripes use foreground tint at low alpha so dark/light themes
   both get a clean shade pair without leaning into any accent hue. */
.tsql-grid tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--foreground) 4%, transparent); }
.tsql-grid tbody tr:hover td { background: color-mix(in srgb, var(--foreground) 9%, transparent); }
.tsql-cell-null { color: var(--muted-foreground); font-style: italic; opacity: 0.7; }
/* Monochromatic table palette — no brand-blue accents inside the grid.
   Bool values use plain foreground weight; the cell-edit input uses the
   strongest neutral border so it still pops without introducing color. */
.tsql-cell-bool { color: var(--foreground); font-weight: 600; }
.tsql-cell-bytes { color: var(--muted-foreground); font-family: var(--font-mono, monospace); display: inline-flex; align-items: center; gap: 3px; }
.tsql-grid-actions-col { width: 30px; }
.tsql-cell-input { width: 100%; padding: 2px 6px; font-size: 11px; border: 1px solid var(--foreground); border-radius: 3px; background: var(--background); color: var(--foreground); font-family: inherit; outline: none; box-sizing: border-box; }
/* Typed cell editors: same chrome as the text input above, but with a
   couple of variant-specific tweaks. They all sit flush in the table cell
   so the row height stays consistent with the read-only grid. */
.tsql-cell-input.tsql-cell-input--bool,
.tsql-cell-input.tsql-cell-input--enum {
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--foreground) 50%), linear-gradient(135deg, var(--foreground) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  padding-right: 22px;
  cursor: pointer;
}
.tsql-cell-input.tsql-cell-input--date,
.tsql-cell-input.tsql-cell-input--time,
.tsql-cell-input.tsql-cell-input--datetime { font-variant-numeric: tabular-nums; }
.tsql-cell-input.tsql-cell-input--number,
.tsql-cell-input.tsql-cell-input--integer { text-align: right; font-variant-numeric: tabular-nums; }
.tsql-cell-input.tsql-cell-input--json { width: 100%; min-height: 60px; max-height: 180px; padding: 4px 8px; resize: vertical; font-family: var(--font-mono, ui-monospace, monospace); white-space: pre; }
/* Calendar / clock indicator inherits the host's foreground colour so it
   doesn't render as a bright OS-default white square on dark themes. */
.tsql-cell-input::-webkit-calendar-picker-indicator { filter: invert(0.55); cursor: pointer; }
.tsql-cell-saved { background: color-mix(in srgb, var(--tedi-diff-added, #22c55e) 22%, transparent) !important; transition: background 0.6s ease; }

.tsql-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 5px 10px; border-top: 1px solid var(--border); background: var(--card, var(--background)); flex-shrink: 0; }
.tsql-pager-label { font-size: 11px; color: var(--muted-foreground); min-width: 80px; text-align: center; }
.tsql-pager-size { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; }
.tsql-pager-size-label { font-size: 11px; color: var(--muted-foreground); }
.tsql-pager-size-select { min-width: 64px; }
.tsql-empty { padding: 18px 14px; color: var(--muted-foreground); font-size: 12px; text-align: center; }

/* Modal dialog - matches the host's AlertDialog/Dialog chrome: bg-popover,
   1 px border, host --radius corners, deep shadow. */
.tsql-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.30); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 2000; backdrop-filter: blur(2px); }
.tsql-dialog { position: relative; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); padding: 18px 20px; min-width: 340px; max-width: 92%; max-height: 92%; overflow-y: auto; box-shadow: 0 20px 50px rgba(0,0,0,0.4); }
.tsql-dialog-title { margin: 0 0 14px; font-size: 13px; font-weight: 600; }
/* Centered form dialog (New/Edit connection) — header row + tidy 2-col grid.
   A taller, roomier modal: flex column with a min-height; the body grows and
   pins the actions to the bottom. */
.tsql-dialog-form { width: 520px; max-width: 92%; min-height: 460px; padding: 16px 18px 18px; display: flex; flex-direction: column; }
.tsql-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; flex: 0 0 auto; }
.tsql-dialog-head .tsql-dialog-title { margin: 0; }
.tsql-dialog-x { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: none; background: transparent; color: var(--muted-foreground); border-radius: 6px; cursor: pointer; transition: background 0.12s, color 0.12s; }
.tsql-dialog-x:hover { background: color-mix(in srgb, var(--destructive) 12%, transparent); color: var(--destructive); }
/* Corner-pinned X (confirm / insert / export modals); the connection-editor
   modal keeps its X in the flex .tsql-dialog-head. Mirrors the host modal's
   absolute top-right X. */
.tsql-dialog-x-corner { position: absolute; top: 14px; right: 14px; }
.tsql-dialog-has-x .tsql-dialog-title { padding-right: 30px; }
.tsql-dialog-form .tsql-dialog-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.tsql-dialog-form .tsql-form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 16px; }
.tsql-dialog-form .tsql-dialog-actions { margin-top: auto; padding-top: 8px; }
.tsql-dialog-form .tsql-input, .tsql-dialog-form .tsql-select { height: 34px; min-height: 34px; padding: 4px 12px; font-size: 12px; }
.tsql-dialog-form .tsql-btn { height: 34px; padding: 0 14px; font-size: 12px; }
/* Read-only SQL preview inside a confirm dialog (edit/delete). */
/* Container for the read-only, syntax-highlighted SQL preview in confirm
   dialogs (delete/update). The CodeMirror inside paints the colors; this just
   supplies the bordered, scrollable box. */
.tsql-dialog-sql { display: block; margin: 0 0 12px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--muted, rgba(127,127,127,0.12)); max-height: 120px; overflow: auto; }
.tsql-dialog-sql .tsql-sql-editor { background: transparent; }
.tsql-dialog-sql .tsql-sql-editor .cm-editor { background: transparent; font-size: 11px; }
.tsql-dialog-sql .tsql-sql-editor .cm-scroller { overflow: hidden; line-height: 1.45; }
.tsql-dialog-sql .tsql-sql-editor .cm-gutters { display: none !important; }
.tsql-dialog-sql .tsql-sql-editor .cm-content { padding: 0 !important; }
.tsql-dialog-sql .tsql-sql-editor .cm-line { padding: 0; }
.tsql-dialog-sql .tsql-sql-editor .cm-activeLine { background: transparent; }
/* Plain-text fallback (host without ctx.ui.codeEditor) keeps a mono look. */
.tsql-dialog-sql .tsql-sql-preview { color: var(--foreground); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
/* Middle action-SQL strip (between editor and table). Height follows the
   query (wraps + grows, caps then scrolls); no line-number gutter, no
   active-line highlight — it's a read-only cue, kept tidy. */
.tsql-action-sql { display: flex; align-items: flex-start; gap: 8px; flex: 0 0 auto; padding: 5px 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--card, var(--background)); }
.tsql-action-sql-label { flex: 0 0 auto; padding-top: 3px; font-size: 9px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted-foreground); }
.tsql-action-sql .tsql-sql-editor { flex: 1 1 auto; min-width: 0; max-height: 132px; overflow-y: auto; overflow-x: hidden; border-bottom: 0; background: transparent; }
.tsql-action-sql .tsql-sql-editor .cm-editor { height: auto; background: transparent; }
.tsql-action-sql .tsql-sql-editor .cm-scroller { overflow: hidden; line-height: 1.5; }
.tsql-action-sql .tsql-sql-editor .cm-gutters { display: none; }
.tsql-action-sql .tsql-sql-editor .cm-content { padding: 0; }
.tsql-action-sql .tsql-sql-editor .cm-line { padding: 0; }
.tsql-action-sql .tsql-sql-editor .cm-activeLine { background: transparent; }

/* Compact confirm modal: title + single message line + actions. Mirrors
   the host's AlertDialog (default + outline buttons, no destructive red),
   so a "Delete connection?" prompt reads the same as the SSH manager. */
.tsql-dialog-confirm { min-width: 320px; max-width: 28rem; padding: 14px 24px; }
.tsql-dialog-confirm .tsql-dialog-title { margin-bottom: 6px; font-size: 17px; font-weight: 500; }
.tsql-dialog-message { margin: 0 0 14px; font-size: 13px; color: var(--muted-foreground); line-height: 1.5; }
/* Match the host AlertDialog footer: two equal full-width columns, an outline
   Cancel + a filled (destructive) action. */
.tsql-dialog-confirm .tsql-dialog-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 0; }
.tsql-dialog-confirm .tsql-dialog-actions .tsql-btn { width: 100%; justify-content: center; height: 36px; }
.tsql-dialog-confirm .tsql-dialog-actions .tsql-btn:not(.is-primary):not(.is-destructive) { border-color: var(--border); }
.tsql-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px 14px; }
.tsql-field { display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: var(--muted-foreground); min-width: 0; }
.tsql-field.is-full { grid-column: 1 / -1; }
.tsql-label { font-size: 11px; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--foreground); }
.tsql-label-type { font-weight: 400; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }

/* Form chrome - mirrors the host's <Input> component (bg-input/50,
   transparent border at rest, --ring on focus, host --radius for
   corners). Compact 28 px height keeps the data-dense workbench
   readable; the connection editor scales them up to 32 px so the modal
   feels closer to the host's 36 px default. */
.tsql-input { box-sizing: border-box; padding: 4px 10px; height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--input) 50%, transparent); color: var(--foreground); font-size: 12px; font-family: inherit; transition: border-color 0.12s ease, background-color 0.12s ease; outline: none; }
.tsql-input:hover { background: color-mix(in srgb, var(--input) 60%, transparent); }
.tsql-input:focus, .tsql-input:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); background: color-mix(in srgb, var(--input) 60%, transparent); box-shadow: none; }
.tsql-input::placeholder { color: var(--muted-foreground); opacity: 0.7; }
.tsql-input[aria-invalid="true"] { border-color: var(--destructive, #ef4444); }
.tsql-input[disabled] { opacity: 0.5; cursor: not-allowed; }
/* Custom dropdown trigger uses the same chrome as inputs so a row of
   [input] [select] reads as one component family. Popup menu is rendered
   into body with the host's --popover bg + 1 px ring + square corners. */
.tsql-select { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; height: 28px; min-height: 28px; border: 1px solid transparent; border-radius: var(--radius, 0); background: color-mix(in srgb, var(--input) 50%, transparent); color: var(--foreground); font-size: 12px; font-family: inherit; cursor: pointer; transition: background-color 0.12s ease, border-color 0.12s ease; min-width: 0; outline: none; }
.tsql-select:hover { background: color-mix(in srgb, var(--input) 60%, transparent); }
.tsql-select:focus, .tsql-select:focus-visible, .tsql-select[aria-expanded="true"] { border-color: var(--ring, var(--primary, #3b82f6)); background: color-mix(in srgb, var(--input) 60%, transparent); box-shadow: none; }
.tsql-select-label { flex: 1 1 auto; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.tsql-select-caret { display: inline-flex; flex-shrink: 0; opacity: 0.7; color: currentColor; transition: transform 0.15s ease; }
.tsql-select[aria-expanded="true"] .tsql-select-caret { transform: rotate(180deg); }

.tsql-select-menu { list-style: none; margin: 0; padding: 6px; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); box-shadow: 0 14px 32px rgba(0,0,0,0.22); max-height: 320px; overflow-y: auto; font-size: 12px; min-width: 180px; }
.tsql-select-item { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: var(--radius, 0); cursor: pointer; font-weight: 500; color: var(--foreground); user-select: none; transition: background 0.1s ease; }
.tsql-select-item:hover, .tsql-select-item:focus-visible { background: var(--accent, rgba(127,127,127,0.1)); color: var(--accent-foreground, var(--foreground)); outline: none; }
.tsql-select-item-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsql-select-item-check { margin-left: auto; flex-shrink: 0; color: var(--primary, #3b82f6); }
.tsql-select-item.is-selected { color: var(--foreground); font-weight: 600; }

/* Right-click context menu (grid copy actions); shares the popover chrome of
   the select dropdown. */
.tsql-context-menu { list-style: none; margin: 0; padding: 5px; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); box-shadow: 0 14px 32px rgba(0,0,0,0.22); font-size: 12px; min-width: 168px; }
.tsql-context-item { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: var(--radius, 0); cursor: pointer; font-weight: 500; color: var(--foreground); user-select: none; transition: background 0.1s ease; }
.tsql-context-item:hover, .tsql-context-item:focus-visible { background: var(--accent, rgba(127,127,127,0.1)); color: var(--accent-foreground, var(--foreground)); outline: none; }
.tsql-context-icon { flex-shrink: 0; display: inline-flex; color: var(--muted-foreground); }
.tsql-context-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsql-context-sep { height: 1px; margin: 4px 6px; background: var(--border); }

/* Read-only Structure dialog: a scrollable metadata grid + a count summary. */
.tsql-structure-summary { margin: 0 0 8px; font-size: 11px; color: var(--muted-foreground); }
.tsql-structure-wrap { max-height: 52vh; border: 1px solid var(--border); border-radius: var(--radius, 0); }
.tsql-structure-grid td { font-variant-numeric: tabular-nums; }
.tsql-structure-grid td:first-child { color: var(--muted-foreground); text-align: right; }

.tsql-checkbox { width: 14px; height: 14px; cursor: pointer; }
.tsql-form-error { margin: 10px 0 0; min-height: 14px; font-size: 11px; color: var(--destructive, #ef4444); }
.tsql-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
.tsql-table-title { font-weight: 600; color: var(--foreground); }
.tsql-error-line { color: var(--destructive, #ef4444); font-weight: 600; }
.tsql-error-text { padding: 10px 12px; background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent); color: var(--destructive, #ef4444); font-family: var(--font-mono, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; }

/* Custom tooltip bubble. Mirrors the host's Radix TooltipContent: --popover
   surface, a 1 px foreground-tinted ring, soft shadow, 11 px text, and the
   same square corners as the rest of TEDI (host sets --radius-2xl: 0). Fades
   + zooms in like the host tooltip. position:fixed + JS-set left/top so it
   escapes the result grid's overflow:auto clipping. */
.tsql-tooltip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 4000;
  pointer-events: none;
  box-sizing: border-box;
  max-width: 20rem;
  padding: 6px 12px;
  border-radius: var(--radius, 0);
  background: var(--popover, var(--card, var(--background)));
  color: var(--popover-foreground, var(--foreground));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), 0 8px 24px rgba(0, 0, 0, 0.18);
  font-size: 11px;
  font-family: inherit;
  line-height: 1.375;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0;
  transform: scale(0.96);
  transform-origin: 50% 100%;
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.tsql-tooltip[data-side="bottom"] { transform-origin: 50% 0%; }
.tsql-tooltip.is-open { opacity: 1; transform: scale(1); }

/* Editable grid cell affordance: the spreadsheet "cell" cursor signals the
   double-click-to-edit behaviour without adding visual noise. */
.tsql-cell-editable { cursor: cell; }

/* "Editable" pill in the query-result meta bar, shown once a free-form
   result is recognised as a single-table SELECT that can be edited in place.
   Soft primary tint so it reads as an affordance, not a warning. */
.tsql-tag--edit {
  gap: 4px;
  background: color-mix(in srgb, var(--primary, #3b82f6) 14%, transparent);
  color: var(--primary, #3b82f6);
  cursor: default;
}
.tsql-tag--edit > svg, .tsql-tag--edit > * { display: block; }

/* Number inputs: the OS-native spin buttons render as a light-on-dark block
   in WebView2 (the host sets no color-scheme), clashing with the themed
   chrome. Hide them and supply our own stacked up/down steppers that paint
   with --muted-foreground + the standard hover lift, matching the icon-button
   chrome used across the workbench. */
.tsql-input[type="number"]::-webkit-outer-spin-button,
.tsql-input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
.tsql-input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
.tsql-num { position: relative; display: inline-flex; align-items: stretch; width: 100%; box-sizing: border-box; }
.tsql-num > .tsql-input { flex: 1 1 auto; width: 100%; padding-right: 22px; }
.tsql-num-steps { position: absolute; top: 1px; right: 1px; bottom: 1px; width: 18px; display: flex; flex-direction: column; border-radius: var(--radius, 0); overflow: hidden; pointer-events: none; }
.tsql-num-step { flex: 1 1 50%; min-height: 0; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; outline: none; pointer-events: auto; transition: background-color 0.12s ease, color 0.12s ease; }
.tsql-num-step:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.16))); color: var(--foreground); }
.tsql-num-step:active { background: var(--accent, rgba(127,127,127,0.24)); }
.tsql-num-step > svg, .tsql-num-step > * { display: block; pointer-events: none; }

/* Narrow-width tweaks. The body is a single editor+results column (the tree
   lives in the host sidebar), so only the result-grid toolbar controls shrink
   to keep the toolbar on one row. */
@media (max-width: 960px) {
  .tsql-input.tsql-grid-search { width: 140px; }
  .tsql-search-wrap--grid { width: 140px; }
  .tsql-select.tsql-grid-colfilter { max-width: 140px; min-width: 84px; }
}
@media (max-width: 540px) {
  .tsql-toolbar { padding: 5px 8px; gap: 4px; }
  .tsql-btn { padding: 4px 8px; }
  .tsql-search-wrap--grid { width: 120px; }
  .tsql-input.tsql-grid-search { width: 120px; }
  .tsql-select.tsql-grid-colfilter { max-width: 120px; min-width: 80px; }
}
@media (max-width: 420px) {
  .tsql-search-wrap--grid { width: 100%; }
  .tsql-input.tsql-grid-search { width: 100%; }
  .tsql-select.tsql-grid-colfilter { max-width: none; width: 100%; }
}
`;

