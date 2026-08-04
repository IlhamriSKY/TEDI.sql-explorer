// SQL Explorer — styles/controls: dialogs (form/confirm/structure), the
// action-SQL strip, form inputs, the custom select + context menus, the tooltip
// bubble, number steppers, and the responsive tweaks. Bundled into extension.js
// by build.mjs. (Concatenated after grid by styles.js.)

export const CONTROLS_CSS = `
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
/* Compact form modal (e.g. Export): a small config modal shouldn't inherit the
   tall connection-editor min-height. Sizes to content; head + actions chrome
   stay identical so it still reads as one modal family. */
.tsql-dialog-form.tsql-dialog-form--compact { min-height: 0; }
.tsql-dialog-form .tsql-input, .tsql-dialog-form .tsql-select { height: 34px; min-height: 34px; padding: 4px 12px; font-size: 12px; }
.tsql-dialog-form .tsql-btn { height: 34px; padding: 0 14px; font-size: 12px; }
/* Read-only SQL preview inside a confirm dialog (edit/delete). */
/* Container for the read-only, syntax-highlighted SQL preview in confirm
   dialogs (delete/update). The CodeMirror inside paints the colors; this just
   supplies the bordered, scrollable box. */
.tsql-dialog-sql { display: block; margin: 0 0 12px; padding: 6px 10px; border: 0; border-radius: var(--radius, 0); background: var(--muted, rgba(127,127,127,0.12)); max-height: 120px; overflow: auto; }
/* No inner bottom hairline inside the confirm-dialog SQL box (the base
   .tsql-sql-editor carries one for the grid preview); the box's own border is
   enough, so the query reads compact. */
.tsql-dialog-sql .tsql-sql-editor { background: transparent; border-bottom: 0; }
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
/* No border-colour rule here on purpose. The confirm footer's Cancel now
   carries .is-outline like every other dialog's, and a
   :not(.is-primary):not(.is-destructive) override would out-specify it
   (5 classes vs 2) and quietly put the button back on --border, which sits
   ~1.1:1 against a dark popover - the very hairline .is-outline exists to
   avoid. */
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
/* Filter box for a searchable dropdown (opts.searchable). Sticky so it stays
   put while a long host list scrolls under it; the menu's own 6px padding is
   cancelled on the sides so the input spans the popup edge to edge. */
.tsql-select-search { position: sticky; top: -6px; z-index: 1; margin: -6px -6px 4px; padding: 6px; background: inherit; border-bottom: 1px solid var(--border); }
.tsql-select-search input { width: 100%; box-sizing: border-box; height: 26px; padding: 0 8px; font: inherit; color: var(--foreground); background: var(--input, transparent); border: 1px solid var(--border); border-radius: var(--radius, 0); outline: none; }
.tsql-select-search input:focus { border-color: var(--ring, var(--primary, #3b82f6)); }
.tsql-select-empty { padding: 10px; text-align: center; color: var(--muted-foreground); }

/* Right-click context menu (grid copy actions); shares the popover chrome of
   the select dropdown. */
.tsql-context-menu { list-style: none; margin: 0; padding: 5px; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); box-shadow: 0 14px 32px rgba(0,0,0,0.22); font-size: 12px; min-width: 168px; }
.tsql-context-item { display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: var(--radius, 0); cursor: pointer; font-weight: 500; color: var(--foreground); user-select: none; transition: background 0.1s ease; }
.tsql-context-item:hover, .tsql-context-item:focus-visible { background: var(--accent, rgba(127,127,127,0.1)); color: var(--accent-foreground, var(--foreground)); outline: none; }
.tsql-context-icon { flex-shrink: 0; display: inline-flex; color: var(--muted-foreground); }
.tsql-context-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tsql-context-sep { height: 1px; margin: 4px 6px; background: var(--border); }
/* Destructive rows (Delete connection, Drop table). Mirrors the host's
   ContextMenuItem variant="destructive": red label AND red glyph at rest so the
   row is avoidable before the pointer lands on it, red-tinted bg on hover. */
.tsql-context-item.is-danger, .tsql-context-item.is-danger .tsql-context-icon { color: var(--destructive, #ef4444); }
.tsql-context-item.is-danger:hover, .tsql-context-item.is-danger:focus-visible { background: color-mix(in srgb, var(--destructive, #ef4444) 12%, transparent); color: var(--destructive, #ef4444); }

/* Read-only Structure dialog: a scrollable metadata grid + a count summary. */
.tsql-structure-summary { margin: 0 0 8px; font-size: 11px; color: var(--muted-foreground); }
.tsql-structure-wrap { max-height: 52vh; border: 1px solid var(--border); border-radius: var(--radius, 0); }
.tsql-structure-grid td { font-variant-numeric: tabular-nums; }
.tsql-structure-grid td:first-child { color: var(--muted-foreground); text-align: right; }
/* Tab bodies (Columns / Indexes / Foreign keys / DDL) share one min-height so
   switching tabs doesn't make the dialog jump around. */
.tsql-structure-body { min-height: 220px; padding-top: 10px; }
.tsql-ddl-wrap { max-height: 52vh; overflow: auto; border: 1px solid var(--border); }
/* The Structure tab bar reuses .tsql-result-tabs; drop its pane padding since
   it sits inside a dialog body that already has its own. */
.tsql-dialog-body > .tsql-result-tabs { padding: 0; background: transparent; }

/* Query history: one row per statement, SQL on the left, actions on the right. */
.tsql-history-list { display: flex; flex-direction: column; gap: 6px; max-height: 56vh; overflow: auto; }
.tsql-history-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); background: var(--card, var(--background)); }
.tsql-history-sql { flex: 1 1 auto; min-width: 0; font-family: var(--font-mono, monospace); font-size: 11px; color: var(--foreground); white-space: pre-wrap; word-break: break-word; max-height: 84px; overflow: hidden; }
.tsql-history-meta { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted-foreground); }

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

/* ---- Custom date / time / datetime picker (dom/datePicker.js) -------------
   Replaces the native WebView2 control, whose popup chips/selection are
   OS-drawn and can't be restyled. Built from the same chrome as the rest of
   the workbench so it's consistent: SQUARE corners (var(--radius, 0)), 1px
   var(--border) borders, --popover surface, theme tokens throughout (dark +
   light). No fixed colors, no border-radius. */
.tsql-dp { position: relative; display: inline-flex; align-items: stretch; width: 100%; box-sizing: border-box; }
/* Input inherits the standard .tsql-input chrome (transparent border at rest,
   --ring on focus) so the datetime fields match the other inputs in the insert
   dialog instead of carrying an inconsistent solid border. Just reserve room
   for the trigger and keep tabular figures. */
.tsql-dp-input { width: 100%; padding-right: 28px; font-variant-numeric: tabular-nums; }
.tsql-dp-trigger { position: absolute; right: 1px; top: 1px; bottom: 1px; width: 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; outline: none; transition: color 0.12s ease; }
.tsql-dp-trigger:hover { color: var(--foreground); }
.tsql-dp-trigger > svg, .tsql-dp-trigger > * { display: block; pointer-events: none; }
/* Popup surface: square + 1px, matching the select/context-menu chrome. */
.tsql-dp-popup { box-sizing: border-box; background: var(--popover, var(--card, var(--background))); color: var(--popover-foreground, var(--foreground)); border: 1px solid var(--border); border-radius: var(--radius, 0); box-shadow: 0 14px 32px rgba(0,0,0,0.22); padding: 8px; font-size: 12px; }
.tsql-dp-popup--time { min-width: 152px; }
.tsql-dp-cal { width: 236px; }
.tsql-dp-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.tsql-dp-title { font-size: 12px; font-weight: 600; color: var(--foreground); }
.tsql-dp-nav { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius, 0); background: transparent; color: var(--muted-foreground); cursor: pointer; outline: none; transition: background 0.12s ease, color 0.12s ease; }
.tsql-dp-nav:hover { background: var(--muted, var(--accent, rgba(127,127,127,0.12))); color: var(--foreground); }
.tsql-dp-nav > svg, .tsql-dp-nav > * { display: block; pointer-events: none; }
.tsql-dp-weekdays, .tsql-dp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.tsql-dp-weekdays { margin-bottom: 2px; }
.tsql-dp-wd { text-align: center; font-size: 10px; font-weight: 600; color: var(--muted-foreground); padding: 2px 0; }
.tsql-dp-day { box-sizing: border-box; height: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius, 0); background: transparent; color: var(--foreground); font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; outline: none; transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease; }
.tsql-dp-day.is-blank { visibility: hidden; cursor: default; }
.tsql-dp-day:hover:not(.is-blank) { background: var(--accent, rgba(127,127,127,0.14)); color: var(--accent-foreground, var(--foreground)); }
.tsql-dp-day.is-today { border-color: color-mix(in srgb, var(--foreground) 35%, transparent); }
.tsql-dp-day.is-selected { background: var(--primary, #3b82f6); color: var(--primary-foreground, #fff); border-color: var(--primary, #3b82f6); }
.tsql-dp-time { display: flex; align-items: center; justify-content: center; gap: 4px; margin-top: 8px; }
.tsql-dp-popup--time .tsql-dp-time { margin-top: 0; }
.tsql-dp-time-field { width: 40px; text-align: center; padding: 4px; height: 28px; border: 1px solid var(--border); border-radius: var(--radius, 0); font-variant-numeric: tabular-nums; }
.tsql-dp-time-field:focus, .tsql-dp-time-field:focus-visible { border-color: var(--ring, var(--primary, #3b82f6)); }
.tsql-dp-colon { color: var(--muted-foreground); font-weight: 600; }
.tsql-dp-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.tsql-dp-foot-right { display: inline-flex; gap: 6px; }
.tsql-dp-foot-btn { height: 26px; padding: 0 10px; font-size: 11px; }

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
