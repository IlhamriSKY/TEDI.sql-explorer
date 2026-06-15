// SQL Explorer — styles/grid: the result + table grids — sticky headers, sort
// affordances, typed cell editors, the saved-flash, and the pager. Bundled into
// extension.js by build.mjs. (Concatenated after layout by styles.js.)

export const GRID_CSS = `
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
`;
