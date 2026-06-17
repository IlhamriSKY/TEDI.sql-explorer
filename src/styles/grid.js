// SQL Explorer — styles/grid: the result + table grids — sticky headers, sort
// affordances, typed cell editors, the saved-flash, and the pager. Bundled into
// extension.js by build.mjs. (Concatenated after layout by styles.js.)

export const GRID_CSS = `
/* Result / table grid: sticky header with a single 1px bottom hairline,
   zebra rows, no horizontal overflow surprise. */
/* min-height keeps a couple of rows visible even at the smallest pane size, so
   the grid never collapses to nothing (the .tsql-host pane scroll then reveals
   the rest); it still grows + scrolls internally on a tall pane. */
.tsql-grid-wrap { overflow: auto; flex: 1 1 auto; min-height: 72px; }
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
/* PK badge: matches the host's Badge "secondary" variant (the same neutral,
   non-bold chrome as the read-only pill .tsql-ro-pill) — keeps the grid's
   monochromatic palette instead of a bold brand-blue outline. */
.tsql-th-pk { flex-shrink: 0; font-size: 9px; font-weight: 500; letter-spacing: 0.02em; line-height: 1; padding: 2px 5px; border-radius: var(--radius, 0); color: var(--secondary-foreground, var(--foreground)); background: var(--secondary, var(--muted, rgba(127,127,127,0.18))); border: 1px solid transparent; }
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
.tsql-cell-input { width: 100%; padding: 2px 6px; font-size: 11px; border: 1px solid var(--foreground); border-radius: var(--radius, 0); background: var(--background); color: var(--foreground); font-family: inherit; outline: none; box-sizing: border-box; }
/* Typed cell editors: same chrome as the text input above, with per-type
   tweaks. (Boolean/enum use the themed dropdown and date/time the custom
   picker, both styled elsewhere.) Numbers right-align with tabular figures;
   JSON gets a resizable mono textarea. */
.tsql-cell-input.tsql-cell-input--number,
.tsql-cell-input.tsql-cell-input--integer { text-align: right; font-variant-numeric: tabular-nums; }
.tsql-cell-input.tsql-cell-input--json { width: 100%; min-height: 60px; max-height: 180px; padding: 4px 8px; resize: vertical; font-family: var(--font-mono, ui-monospace, monospace); white-space: pre; }
.tsql-cell-saved { background: color-mix(in srgb, var(--tedi-diff-added, #22c55e) 22%, transparent) !important; transition: background 0.6s ease; }
/* Boolean / enum cell editor: the custom themed dropdown (.tsql-select) trigger
   fills the cell and stays compact, matching the other inline editors while
   opening the same .tsql-select-menu the rest of the app uses. */
.tsql-select.tsql-cell-select { width: 100%; height: auto; min-height: 24px; padding: 3px 8px; font-size: 11px; }

.tsql-pager { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 5px 10px; border-top: 1px solid var(--border); background: var(--card, var(--background)); flex-shrink: 0; }
.tsql-pager-label { font-size: 11px; color: var(--muted-foreground); min-width: 80px; text-align: center; }
/* Rows-per-page selector, now in the table toolbar next to the Row button.
   Sized like the column-filter so the toolbar controls share one baseline. */
.tsql-select.tsql-grid-pagesize { height: 28px; min-height: 28px; max-width: 110px; min-width: 88px; font-size: 11px; }
.tsql-select.tsql-grid-pagesize .tsql-select-label { font-weight: normal; }
.tsql-empty { padding: 18px 14px; color: var(--muted-foreground); font-size: 12px; text-align: center; }
`;
