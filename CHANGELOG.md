# Changelog

All notable changes to the TEDI SQL Explorer extension are documented here.

## 0.2.16 (2026-05-26)

- Fix: 0.2.15 activation crash. A CSS comment inside the STYLES_CSS
  template literal referenced `position: relative` with literal
  backticks, which closed the template early and made the JS parser
  choke on the following text ("Unexpected identifier 'position'").
  Replaced with plain text so the comment stays informative without
  breaking the template. Same class of bug as v0.2.10.

## 0.2.15 (2026-05-26)

Form chrome aligned with TEDI host, autocomplete now covers SQL syntax.

- Form chrome (inputs, selects, buttons, icon buttons, modal close,
  tree rows, conn rows, row actions, search-clear, select menu items)
  now uses the host's design tokens directly: `var(--radius)` for
  corners (so the panel matches the host's square-corner theme), the
  `color-mix(var(--input) 50% / transparent)` background pattern used
  by the `<Input>` component, transparent border at rest, `var(--ring)`
  border on focus / `[aria-expanded]`, and `var(--muted)` on hover.
  Buttons match `<Button variant="outline" size="sm">` (28 px tall,
  --border outline, --muted hover) so a row of [Run] [Stop] [Export]
  reads as the same chrome family as the SSH manager / Settings page.
- Connection-editor modal scales inputs + selects + buttons up to 32 px
  so the form feels closer to the host's 36 px default without making
  the workbench toolbar feel oversized.
- Schema-tree rows + conn-rail rows now expose an `.is-active` state
  that paints with `var(--accent)` + `var(--accent-foreground)` (was
  hard-coded grey), so dark / light / brand-tinted themes all paint a
  visible "you are here" highlight.
- Query-editor autocomplete now suggests SQL syntax in addition to
  schema. Three new buckets:
  - common SQL keywords (`SELECT`, `JOIN`, `GROUP BY`, `RETURNING`, etc.)
    with the `keyword` icon glyph and boost 10
  - common SQL functions (`COUNT`, `COALESCE`, `ROW_NUMBER`, etc.) with
    the `function` glyph and boost 8
  - common SQL data types (`INT`, `VARCHAR`, `JSONB`, etc.) with the
    `type` glyph and boost 3
  Plus engine-specific extensions pulled from the active session's
  connection kind: MySQL gets `AUTO_INCREMENT`, `UNSIGNED`, `IFNULL`,
  `GROUP_CONCAT`, …; PostgreSQL gets `SERIAL`, `JSONB`, `ILIKE`,
  `DATE_TRUNC`, `STRING_AGG`, …; SQLite gets `AUTOINCREMENT`, `PRAGMA`,
  `STRFTIME`, …. Tables outrank keywords (boost 12 vs 10) so the first
  match after `FROM ` is still the table; columns drop to boost 5 so
  they surface mainly when the prefix is column-shaped.
- Table entries now use the `class` icon glyph (capital C) instead of
  `type` so SQL data types and tables don't share the same letter in
  the autocomplete popup.

## 0.2.14 (2026-05-26)

Search input + splitter polish.

- Search-input clear (X) button: previously its inner SVG inherited
  inline display from the host icon API, which could push the button
  out of its absolutely-positioned slot and parked the X under the
  input on some Webview2 builds. The button now forces a flex-shrink: 0
  box with `display: block` on the icon child plus `pointer-events: none`
  so the click always hits the wrapping button, and the wrap is
  declared `position: relative` on the base class (not just the variant)
  so both tree-search and grid-search share identical anchoring.
- Removed the leftover hairline above the editable table grid. The
  toolbar row already separates itself with its card-tinted background;
  the extra `border-top` made the search + filter strip look like it
  was hovering on a thin rule. Matches the 0.2.12 cleanup of the other
  toolbar separators.
- Schema tree list now scrolls flush to the top of its scrollport. The
  4 px top padding on `.tsql-tree-list` was leaving a visible gap above
  the first database row when the list scrolled to position 0; gutter
  moved to the head (`padding-bottom: 6px` on `.tsql-tree-head`) so the
  spacing stays the same but rows actually reach the top edge.
- Editor / results splitter now uses pointer events instead of mouse
  events, so the drag works on touch + pen surfaces (Surface, iPad
  with a trackpad, etc.). Added pointer-capture so a drag doesn't lose
  focus when the cursor leaves the 6 px hit-area, plus keyboard nudge
  (Up/Down on the splitter shrinks / grows the editor by 16 px) and a
  focus-visible indicator so keyboard users can see the handle.
- Tighter responsive grid: new 960 px and 420 px breakpoints squeeze
  the grid search input + column filter widths down so the toolbar
  stays single-row on narrower workbenches; below 420 px the search +
  filter expand to full width and stack instead of wrapping awkwardly.

## 0.2.13 (2026-05-26)

- Accordion-style schema tree: expanding a database now auto-collapses
  every sibling DB so only one is open at a time. Schemas inside the
  active DB stay independent (so users can compare two schemas at the
  same time) - the lock is just at the database level. Connections with
  a pinned database render a single DB node, so behaviour there is
  unchanged.
- Query editor autocomplete for tables and columns. As you expand the
  tree and open tables, the extension fills a per-session schema cache;
  the query editor pulls matching tables + columns from that cache on
  every keystroke (case-insensitive prefix match). Tables float to the
  top of the menu via boost so the first hit after `FROM ` is usually
  what you wanted; column suggestions include the parent table in the
  detail column so same-named columns from different tables stay
  distinguishable. Requires TEDI >= 0.3.3 for the host autocomplete
  hook (`ctx.ui.codeEditor` completions option); older hosts ignore it
  silently so the extension still loads.

## 0.2.12 (2026-05-26)

Workbench layout polish.

- Removed the bottom border line under every toolbar / subheader / tree
  head / editor / result-tabs / result-meta strip. The card-tinted
  background and search-input outline already give enough visual
  separation; the extra hairline was redundant and made the workbench
  look busier than the host's Settings panes.
- Replaced the native `<select>` column filter in the table toolbar with
  the same custom `select()` dropdown used by the connection editor:
  outline trigger, ArrowDown01Icon caret, popup rendered into body with
  Tick02Icon on the selected option. Now visually consistent with every
  other dropdown in the workbench.
- Schema list scrollbar no longer crawls up past the search filter row.
  Made `.tsql-tree` a flex column with the head fixed (`flex: 0 0 auto`)
  and the list scrollable on its own (`flex: 1 1 auto; overflow-y:
  auto`). The scrollbar now starts beneath the search input where the
  scrollable rows actually begin.
- Query editor and results pane are now vertically resizable. A 6px
  splitter sits between them with a centred drag indicator that paints
  only on hover / drag. Drag updates a CSS variable on the parent so the
  editor takes the dragged height and results flexes into the rest.
  Clamps at min 80px editor / min 120px results so neither pane can
  collapse beyond usability. The height is persisted on the session so
  switching connections (or remounting the panel) keeps the user's
  preferred split.

## 0.2.11 (2026-05-26)

- Search inputs (schema rail "Search databases" + table grid "Search rows")
  now render the clear (X) button as a HugeIcon (Cancel01Icon) overlaid on
  the right edge of the input, sharing the same currentColor + hover-bg
  treatment as iconButton / textBtn / row actions. Replaces the previous
  browser-native type=search clear, which painted in the OS chrome colour
  and did not match the workbench icon family. The clear button hides
  while the input is empty and appears the moment the user types one
  character; clicking it empties the input and refocuses for fresh input.

## 0.2.10 (2026-05-26)

Hotfix: the extension failed to activate in 0.2.9 with
`SyntaxError: Invalid left-hand side expression in postfix operation`.
Inside the `STYLES_CSS` template literal a connection-editor CSS comment
used markdown-style inline-code backticks (`` `--primary` ``, `` `outline` ``,
`` `border` ``, `` `#settings-root` ``). Each one closed the JS template literal
prematurely, so the parser tried to evaluate the trailing CSS as code
and bailed. The Database icon in the header bar never registered, the
SQL Explorer tab never opened, and no toast surfaced because activation
threw before any setItem call. Replaced the inline-code styling with
plain quotes/dashes; behaviour is otherwise identical to 0.2.9.

## 0.2.9 (2026-05-26)

UI polish around connection editor, schema tree, and the row grid.

- Delete row now opens the styled confirm modal (Esc / Enter / overlay
  click) instead of the browser's native `confirm()`. Consistent with
  the existing "Delete connection" flow.
- Connection editor modal restyled to match the host Settings window:
  brand `--primary` outline + 0.5rem radius + faded card-tinted header.
  The border uses `outline` + negative offset so it survives WebView2
  edge clipping on Windows resize.
- Connection rail loses its top padding so the first row sits flush
  under the SQL Explorer header.
- Schema search input + subheader are pinned in a sticky wrapper, so
  they stay visible while the database tree scrolls.
- Data table goes monochromatic. Bool values + cell-edit input border
  drop the `--primary` blue and use `--foreground` instead; zebra rows
  and hover state use `color-mix(foreground, transparent)` so both
  dark and light themes get a clean shade pair with no accent hue.
- Sortable column headers: click a TH to cycle unset → asc → desc →
  unset. `order_by` + `order_dir` flow to `/table-rows`, so the sort
  applies across pages, not just the visible window. ▲ / ▼ indicator
  on the active column.
- In-grid search + column filter. The toolbar gets a search input plus
  a column dropdown ("All columns" or one specific column). Filtering
  is client-side over the loaded snapshot (so it's instant and
  doesn't widen the sidecar API surface). State persists across page
  changes / reloads / sort flips.

## 0.2.8 (2026-05-26)

Identifier handling + UI polish.

- Identifier escaping for table / column / schema names with hyphens,
  digits, or non-ASCII characters. The previous strict allow-list
  (`is_safe_ident`) rejected real-world names like `my-table` or
  `2025_logs`; the new escape-and-quote pipeline (`escape_mysql_ident`,
  `escape_pg_ident`, `escape_sqlite_ident`) handles them the same way
  phpMyAdmin / psql do. Values still flow through bound parameters via
  the per-backend `bind_json` helpers, so the SQL itself never carries
  user-supplied data.
- Modal / overlay survives panel rerenders. Editing a connection no
  longer drops the dialog when the user clicks another row in the
  connection rail; the host's `.tsql-conn-modal` and `.tsql-overlay`
  nodes are detached before `clearChildren` runs and re-attached after.
- Manifest description trimmed to one sentence so the install dialog
  reads cleanly alongside the other reference extensions.
- Sidecar refactor: `edit.rs` / `export.rs` / `schema.rs` reshuffled
  around the new identifier-quoting path.

## 0.2.5 (2026-05-26)

Dropdowns + brand marks now match the host's Settings dialog style.

- Custom dropdown replaces every native `<select>` in the extension.
  Visual parity with TEDI Settings DropdownMenu: h-32 outline trigger,
  ArrowDown01Icon caret that rotates 180 on open, rounded popup
  rendered into `document.body`, items with `Tick02Icon` for the
  selected value, click-outside + Escape to close. Same dropdown
  pattern for Engine / TLS / Mode (in the connection dialog) and
  Format (in the export dialog).
- Engine dropdown items each carry their brand mark, so the user sees
  the MySQL dolphin / PostgreSQL elephant / SQLite feather next to
  the option label and on the collapsed trigger. The trigger reads as
  "[brand] MySQL / MariaDB" when collapsed.
- Brand marks refined: cleaner silhouettes, sharper eye / wave
  details, brighter on the kind-coloured background.

## 0.2.4 (2026-05-25)

CRUD audit pass + query editor parity with the host code editor.

- Query editor replaced with a real CodeMirror 6 mount via the new
  `ctx.ui.codeEditor` host API. SQL keywords, strings, numbers,
  comments are syntax-highlighted using the same palette tier as
  TEDI's main editor. Language is picked per connection kind
  (`sql:mysql`, `sql:postgres`, `sql:sqlite`). Line numbers, history,
  selection, line-wrap, and active-line gutter all wired.
- Workspace tab icon: TabBar now renders the `Database01Icon` HugeIcon
  in sky-blue (the same `--tedi-tab-ssh` accent SSH terminal tabs
  use) so a SQL Explorer tab reads as part of the remote-dev cluster.
- Password prefetch: the connection dialog now `await`s the keychain
  before painting. Editing a connection no longer races the secret
  load, so a quick "Test" click after Edit always carries the saved
  password.
- CRUD audited end-to-end:
  - UI insert: `openInsertDialog` → `/table-insert` → success toast.
  - UI read: `loadTableRows` → `/table-rows` with pagination + total
    count.
  - UI update: double-click cell → `/table-update` keyed on PK.
  - UI delete: row action → confirm → `/table-delete`.
  - Query insert / update / delete / DDL: free-form via the editor's
    multi-statement runner, gated on the connection's `allow_writes`
    flag with destructive-statement typed confirmation.
- Requires TEDI >= 0.2.26 for `ctx.ui.codeEditor`.

## 0.2.3 (2026-05-25)

Layout, badges, and responsive polish.

- Connection-row badges replaced with stylised MySQL / PostgreSQL /
  SQLite brand marks (inline SVG, brand-coloured backgrounds). Replaces
  the `MY` / `PO` / `SQ` text labels.
- Auto-collapse the host file-explorer sidebar when the SQL Explorer
  tab opens, via the new `ctx.app.setSidebarVisible(false)` host API.
  Users can re-open the sidebar manually from the header toggle.
- Connection dialog: `Database` field marked `(optional)` with a
  placeholder explaining that an empty value browses all databases the
  account can see. The schema tree always lists every database the
  connection has access to.
- Result + table grid polished: zebra row striping, sticky header
  shadow, bigger padding, cleaner editable-cell input border, status
  bar styling.
- Native dropdown caret + `cursor: pointer` on every `<select>`.
- Responsive: connection rail and schema tree shrink (and at narrow
  widths collapse into a horizontal strip above the workspace) so the
  workbench works on a half-screen pane.
- Toolbars wrap on narrow widths; buttons gain hover border + smooth
  transitions.
- Requires TEDI >= 0.2.26 for `ctx.app.setSidebarVisible`.

## 0.2.2 (2026-05-25)

Header button + toolbar polish.

- Header button (next to SSH) now paints `Database01Icon` from
  HugeIcons via the new `hugeicon:` icon prefix, matching the host's
  SSH / Extensions / Settings buttons in stroke and color.
- Toolbar buttons (Run / Stop / Export / Reload / Row / Close / Prev /
  Next): label text is wrapped in a `<span>` so CSS `gap` rules render
  the spacing between icon and text properly. They were touching
  before because anonymous text nodes are not flex children.
- Toast on delete-row success.

## 0.2.1 (2026-05-25)

UI polish, all icons now HugeIcons (matched TEDI core chrome).

- Every Unicode / emoji icon replaced with a `ctx.ui.icon(...)`
  HugeIcon call so the SQL Explorer button row reads as part of the
  same icon family as the host header (Add01Icon, Refresh01Icon,
  PlayIcon, Database01Icon, Folder01Icon, Table01Icon, ViewIcon,
  Delete02Icon, PencilEdit01Icon, ArrowLeft01Icon, ArrowRight01Icon,
  Cancel01Icon, Download01Icon, CodeIcon, SquareIcon).
- Tree carets rotate via CSS now (one icon mount per row, no React
  root churn on expand/collapse).
- Connection dialog: "Allow writes" checkbox replaced with a "Mode"
  dropdown (Read-only / Read + Write).
- Success toasts: connection test, add/update connection, insert row,
  export, and sidecar restart now surface a green toast on success.
- Requires TEDI >= 0.2.26 for the new `ctx.ui.icon` host API.

## 0.2.0 (2026-05-25)

UI surface change. The workbench moved off the right-panel slot into a
full workspace tab, and the toggle moved off the status bar into a
header button next to the SSH icon.

- Header button (right of SSH) opens or focuses the SQL Explorer tab.
  Mod+Alt+D keybind unchanged.
- Tab content uses the full workspace area instead of the narrow right
  panel. Connection rail, schema tree, editor, and result grid all get
  more breathing room.
- Manifest: `panels[].surface` changed from `right` to `tab`. The new
  surface skips the auto-rendered status-bar toggle entirely.
- Requires TEDI >= 0.2.26 for the new `ctx.headerBar` and
  `ctx.tabs.openExtensionTab` host APIs.

## 0.1.0 (2026-05-25)

Initial release.

- Native Rust sidecar (`tedi-sql-helper`) speaking HTTP+JSON on `127.0.0.1`
  with a per-session bearer token. Loopback bind, token rotated on every
  boot, never written to disk.
- Driver matrix via [`sqlx`](https://crates.io/crates/sqlx):
  - MySQL / MariaDB (TLS via native-tls)
  - PostgreSQL (TLS via native-tls)
  - SQLite (read/write or read-only modes)
- Connection manager
  - Stored under `ext:tedi.sql-explorer:connections` in TEDI settings.
  - Passwords stored separately in the OS keychain (`secrets:write`),
    never in the settings JSON.
- Schema browser
  - Databases → schemas → tables / views → columns.
  - Lazy fetch; refreshable per node.
- Query editor
  - Multi-statement scripts (split on `;` honouring quote/escape state).
  - Run / Stop / cancel via abort-signal forwarded to the sidecar.
  - Per-statement timing + rows-affected.
- Result grid
  - Paginated, sortable, column-resize, copy cell.
  - Inline edit with dirty-marker; save-as-UPDATE issued via prepared
    statements using the table's primary key.
  - INSERT new row and DELETE selected rows.
- Export
  - CSV (RFC 4180), JSON, and `INSERT` SQL.
  - Output via the standard TEDI save-file dialog.
- Security
  - Sidecar enforces an `allow_writes` flag per connection; SELECT-only by
    default. Toggle requires explicit confirmation.
  - Read row caps and query timeout (configurable per connection).
  - `DROP DATABASE` / `TRUNCATE` / `DROP SCHEMA` require a typed
    confirmation in the host UI before the statement reaches the sidecar.
