# Changelog

All notable changes to the TEDI SQL Explorer extension are documented here.

## [0.4.10] - 2026-08-03

- Add: the workbench reopens where you left it. The connection that was open and
  the SQL in its editor are remembered, so they come back after a restart, and
  the pane makes that connection live again once the helper is up. That is also
  what makes floating the pane useful: the float window runs its own copy of the
  extension, so before this it opened on "no connection selected" instead of the
  database you popped out. Results are not kept, since a grid belongs to a query
  run rather than to the workbench.

## [0.4.9] - 2026-08-03

- Add: the workbench pane can be floated into its own window (needs TEDI 0.4.5).
  The float window runs its own copy of the extension, so two things had to
  change for it to be one workbench rather than two: the running
  `tedi-sql-helper` is now shared between windows (its endpoint is published to
  the extension store and probed on `/healthz` before it is adopted), instead of
  each window spawning its own helper with its own database sessions and leaving
  it running after the window closes; and the saved connection list is re-read
  whenever the panel mounts, so a connection added in the float window is there
  when you dock back. A read that is in flight while this window saves is
  dropped rather than allowed to overwrite it.
- Fix: a single failed request no longer kills a helper that another window is
  using. The respawn path confirms the process is really gone before killing it.

## [0.4.8] - 2026-07-18

- Fix: the pane drag splitter now reads exactly like every other pane separator
  in the app. Only the 1px line lights up (primary at 50%) on hover, drag, and
  focus; the 24x4 grip stays grey (`--tedi-resize-handle`) instead of turning
  solid blue, and the line sits centered in the 6px handle rather than pinned to
  its top edge, matching the app's own ResizableHandle.
- Change: project links point at the TEDI website (https://tedi.ilhamriski.com/)
  in `manifest.json` and the README.

## [0.4.7] - 2026-07-06

- Change: migrated the extension icons from Hugeicons to Lucide (`lucide:` refs
  resolved by the host), matching the TEDI app icon system after its Lucide
  migration. Same glyphs, no visual change.

## [0.4.6] - 2026-07-04

- Fix: the pane drag splitter's divider line is now a crisp solid 1px line along
  the top edge (`var(--border)`) instead of a faint semi-transparent line
  centered in the 6px handle, so the boundary between the query editor and the
  result grid reads more clearly. Hover / drag / focus states are unchanged.

## [0.4.5] - 2026-06-17

- Feat: **collapsible query editor** — a Hide / Show editor toggle in the pane
  toolbar folds the CodeMirror editor (and its drag splitter) away so the result
  grid gets the full pane height; handy when browsing a table.
- Feat: **the pane scrolls when it is short** — when a split-pane leaf is
  shorter than the workbench minimum, the whole pane scrolls vertically so the
  toolbar, editor, result meta, grid and pager stay reachable instead of being
  clipped. The grid keeps a usable minimum height (a couple of rows) rather than
  collapsing, and the result body no longer spawns a confusing second scrollbar.
  (Pairs with TEDI core >= 0.3.39, which gives a split-pane extension panel a
  definite height; in a tab the panel already scrolled.)
- Fix: the themed dropdowns (boolean / enum cell editor, page-size, column
  filter) now close on scroll, so they no longer float detached from their
  trigger once the pane can scroll.
- Chore: drop dead native date / select CSS left over from the custom-widget
  migration, and extract the query editor + splitter into a `renderQueryEditor`
  helper.

## [0.4.4] - 2026-06-17

- Feat: **custom themed date / time / datetime picker** replacing the native
  WebView2 control, whose calendar popup can't be styled. Square corners, 1px
  borders, full dark / light support via theme tokens; used by both the inline
  cell editor and the Insert dialog.
- Feat: **custom themed boolean / enum dropdown** (the shared `select()` menu)
  replacing the native `<select>`, so its option list matches every other
  dropdown in the app in both themes (square, 1px, tick on the selected item).
- Improve: the **Export** modal now uses the shared centered-dialog chrome, and
  the **Insert** dialog is a tidy 2-column form with input chrome consistent
  across all field types.
- Improve: the confirm-dialog SQL preview is compact (no inner hairline / box
  border); the **PK** badge is neutral and non-bold (host Badge "secondary"
  look); the rows-per-page selector moved next to the Insert (`+Row`) button;
  the result grid fills the available height.
- Fix: a click-away on an unchanged date / time / datetime cell no longer fires
  a spurious, precision-dropping UPDATE (the no-op check normalizes the raw
  server value); NULL / default option sentinels are collision-safe; the themed
  dropdown dismisses cleanly on Tab.

## [0.4.3] - 2026-06-16

- Fix: restore the schema-tree node-id separator to its original control char
  (`\x01`); the 0.4.2 refactor inadvertently changed it to `\x1f`. Behaviour is
  identical (the separator is internal-only and never appears in identifiers),
  but this keeps the value faithful to the pre-refactor source.
- CI: bump `actions/checkout` and `actions/setup-node` to v5 (Node 24 runtime)
  to clear the Node 20 deprecation warnings.

## [0.4.2] - 2026-06-15

- Refactor: the `src/` tree is split into focused **feature folders** behind
  same-named barrels (`dialects/`, `dom/`, `grid/`, `gridedit/`, `query/`,
  `render/`, `tree/`, `connections/`, `styles/`); **every source file is now
  ≤ 300 lines** (no "god modules"). Behaviour-preserving (verbatim moves plus
  one inline-edit dedup). See README → Development for the folder map.
- Refactor: per-engine differences (quoting, connection URL, TLS, autocomplete
  vocabulary, labels) now live in a **dialect registry** (`src/dialects/`), so
  adding a database engine is a one-file change.
- Build: `extension.js` is **no longer committed** — it is the generated bundle
  and is built from `src/` by CI (`release.yml`) into the release `.zip` that
  users install. `build-check.yml` now validates the build instead of diffing a
  committed bundle. (Reverses 0.4.1's "single committed artifact" note.)
- No user-facing behaviour change.

## [0.4.1] - 2026-06-15

- Feat: right-click any grid cell to **Copy cell**, **Copy row** (TSV), or
  **Copy row as INSERT** — works on read-only connections too.
- Feat: **Structure** view (read-only) showing each column's ordinal, type,
  nullability, key, default, and extra, from the existing `/columns` data.
- Feat: grid headers now show each column's **type** + a **PK** badge, with a
  richer hover tooltip (type · key · nullability · default).
- Feat: **rows-per-page** selector (10 / 25 / 50 / 100 / 500) on the table grid.
- Feat: the Insert dialog now uses **typed inputs** per column (boolean / enum
  dropdowns, date-time pickers, number steppers) with an explicit `(NULL)` /
  `(default)` choice, matching the inline cell editor.
- Fix: saved **SQLite** connections broke on reconnect/edit (the file path was
  read from a host field that defaulted to `127.0.0.1`); the path is now stored
  and read consistently in `sqlitePath`.
- Fix: deleting a connection now actually **wipes its keychain credential**
  (the confirm dialog previously claimed this without doing it); SQLite
  connections no longer claim a credential they don't store.
- Fix: a dead sidecar is now detected and **auto-restarted** on the next request
  instead of failing until the extension is re-enabled.
- Fix: editing an unchanged `tinyint(1)` boolean no longer fires a spurious
  no-op UPDATE; integer cell editors are right-aligned like number cells; open
  dropdown menus no longer leak DOM/listeners on teardown.
- Refactor: the UI is now authored as small ES modules under `src/` and bundled
  into `extension.js` with esbuild (`npm run build`). No behavior change — the
  4.9k-line single file is split into 15 focused modules (see README →
  Development). The shipped `extension.js` stays a single committed artifact.

## [0.4.0] - 2026-06-13

- Feat: the connection list now lives in the host's left sidebar as a
  workspace-styled "Databases" section (via the new `ctx.sidebar` API on
  TEDI >= 0.3.37). Add / refresh / per-row edit / delete and the live
  connection-status tint are rendered by the host with the same chrome as the
  Workspaces panel; the section appears only while the extension is enabled.
  Clicking a connection opens (or focuses) the workbench pane and connects.
- Feat: the workbench main area is now a compact **[Table | Query]** tab
  switcher. The Table tab is the editable data grid for the open table; the
  Query tab is the SQL editor + results. Opening a table from the tree jumps to
  the Table tab; running a query jumps to the Query tab. Only the active view is
  mounted, so the CodeMirror editor and the table grid never stack — it fits a
  narrow split pane. Switching views rebuilds only the main area, so the schema
  tree keeps its expansion.
- Change: the in-pane tree is now scoped to the **active** connection (its
  databases → schemas → tables) instead of listing every connection — the
  connection list moved to the host sidebar. Opening the workbench no longer
  collapses the left sidebar (that is where connections live now).
- Change: requires TEDI host >= 0.3.37 (`ctx.sidebar`). Adds the
  `sidebar:write` permission. On older hosts the sidebar section is skipped
  (guarded); the workbench still opens from the header button / `Mod+Alt+D`.

## [0.3.2] - 2026-06-13

- Feat: surface-aware layout. When the host mounts the workbench as a
  split-pane leaf (next to a terminal / editor / browser) it now renders
  header-less — the pane frame already supplies the title + drag handle +
  close — and folds the New-connection / Restart actions into the sidebar
  head. Reads as a native pane instead of stacking a second header. The
  workspace-tab layout is unchanged. (Activates only on a TEDI host that
  supports extension panels in split panes; older hosts always render the
  tab layout.)

## [0.3.1] - 2026-06-13

- Style: compact the result grid and query editor so more data fits on
  screen. Table rows are denser (cell padding 5px/10px → 3px/9px, header
  6px/10px → 4px/9px); the toolbar, result-meta, grid-meta and pager bars
  are tightened; the query editor now defaults to 38% height (was 45%) so
  results get more room, and the executed-SQL preview caps at 108px (was
  132px). CSS-only — no behavior change.

## [0.3.0] - 2026-06-13

- Feat: the left panel is now one unified tree — each connection is a root
  node that expands to its databases → schemas → tables, with a single
  search box filtering every level. The old connection rail + schema tree
  are merged into one resizable, collapsible sidebar (drag the splitter or
  use the header toggle), so the workbench fits a narrow split pane next to
  a terminal/editor. Sidebar width + collapsed state persist across reopen.
- Feat: free-form single-table SELECT results are editable in place
  (double-click a cell) when the result maps 1:1 to a base table with a
  primary key, reusing the table-browse edit path.
- Feat: connection-editor numeric fields (query timeout / row cap) use
  themed up/down steppers; every `title` renders through a styled tooltip
  layer matching the host popover instead of the OS-native bubble.
- Security: `/export` no longer bypasses the read-only flag — raw-SQL
  exports are gated on `allow_writes`, so a read-only connection can no
  longer run DELETE/DROP through the export path.
- Security: the `/query` read-only gate now rejects data-modifying CTEs
  (`WITH … DELETE`), `EXPLAIN ANALYZE <write>`, and unrecognised write
  statements (COPY FROM, LOAD DATA, REFRESH MATERIALIZED VIEW) that
  previously slipped past the first-keyword check on read-only connections.
- Security: connection pool size is clamped (≤ 50), and `USE` /
  `SET search_path` route through the same identifier escaping as every
  other inlined identifier.
- Fix: SQL-format export emits engine-correct identifier quoting + binary
  literals for PostgreSQL / SQLite (was MySQL-only backticks + FROM_BASE64,
  producing invalid re-runnable SQL for PG/SQLite).
- Fix: MySQL `TINYINT UNSIGNED` (and other UNSIGNED integers) no longer
  decode to NULL.
- Fix: the primary-key cache is keyed by `db.schema.table`, so two
  same-named tables in different databases no longer return each other's PK
  metadata (which could build a wrong WHERE on edit/delete).
- Fix: destructive-query and sidecar-restart confirmations use the in-app
  dialog instead of native `confirm()` / `prompt()`, which silently no-op in
  the macOS/Linux webview.
- Fix: CodeMirror views are disposed when the tab is closed (no leak); on a
  CPU arch the release doesn't ship a sidecar for, the error now says
  "unsupported platform" instead of a misleading "reinstall" hint.
- Chore: removed dead code (unused error variants/methods/CSS/helpers),
  collapsed duplicated per-backend row collectors / counters into macros,
  and dropped the unused `column_types` wire field and `tower` dependency.
- Docs: README minimum-TEDI version corrected to 0.3.9; release-workflow
  comment fixed (logo.png).

## [0.2.30] - 2026-05-28

- Feat: query mode now gets the same tree indication as browsing. When a
  statement runs (or is typed), the table it references is highlighted in
  the schema tree with the same calm cue as an open table (soft tint +
  flush left bar + bold), so you can always see which table the result
  belongs to. Previously only browsed tables were marked.
- Style: browse and query highlights are mutually exclusive, so exactly
  one table is ever in focus: opening a table clears the query cue, and
  the query cue clears the browse highlight. Running a query drops the
  now-stale browse highlight and marks the queried table.
- Fix: the navigation pulse no longer re-fires on every keystroke when the
  referenced table is unchanged, and it settles into the resting tint
  instead of flashing out to transparent.
- Verified browse vs query side-by-side with a rendered preview.

## [0.2.29] - 2026-05-28

- Style: tone down the tree active highlight introduced in 0.2.28, which
  made the current database and its open table two loud adjacent blue
  blocks that merged into one confusing region. Now only the open
  table/view carries the highlight (a soft primary tint + flush left bar +
  bold label), while the active database stays subtle (bold label +
  primary-tinted caret / icon, no fill or bar). Verified with a rendered
  side-by-side preview.
- Style: soften the SQL-driven navigation pulse so it no longer flashes a
  saturated blue across the row.

## [0.2.28] - 2026-05-28

- Style: active schema-tree row (selected database / open table) is now a
  cohesive highlighted block instead of a lonely left stripe. The 2 px
  primary accent moved onto `.is-active` itself as a flush inset
  box-shadow (square corners, full row height) so it merges with the
  accent fill rather than reading as a detached line.
- Feat: the open table is highlighted in the tree. Its row now changes
  background and text colour (label, icon, caret, and row count all shift
  to the active foreground), not just showing the blue left line.
  renderTableNode marks the row matching `session.activeTable`, and
  `openTable` toggles it live without a full tree rebuild.
- Style: the SQL-driven navigation cue (`.is-target`) also squares its
  corners so its accent bar stays a clean, connected vertical line.

## [0.2.27] - 2026-05-28

- Fix: connection rail subtitle no longer renders dangling separators when
  a connection has no user and no pinned database. The host/database tail
  is now built from non-empty parts only, so it reads "MySQL · 127.0.0.1:3306"
  instead of "MySQL · @127.0.0.1:3306/".
- Style: schema-tree rows span the full pane width so the hover / active
  background reaches the left edge on nested schema and table rows.
  Indentation moved off the child list's left padding onto a depth-based
  left padding on each row (CSS var `--tsql-depth`), keeping the same
  visual indent while the row background fills the gutter.
- Style: result and table grid header divider is a single 1 px hairline.
  Removed the `box-shadow` on the sticky `thead th` that stacked a second
  line under the existing `border-bottom`.
- Feat: free-form query-result view now mirrors the table-browse view.
  The row search uses the shared clear (X) button instead of the browser
  native `type=search` control; pagination moved from the cramped top-right
  inline control into a bottom footer (Prev / Page X / Y / Next).
- Feat: the executed statement above a result grid renders in a read-only,
  syntax-highlighted code editor (`ctx.ui.codeEditor` with `readOnly`)
  instead of a single-line grey text strip, so the SQL reads as real code
  and stays selectable. Falls back to the plain text strip on hosts without
  the code-editor API.
- Chore: read-only preview editors are tracked and disposed on every
  re-render, statement-tab switch, and deactivate so they no longer leak an
  EditorView per query.

## [0.2.26] - 2026-05-28

- Fix: 0.2.25 activation crash. Two CSS comments inside `STYLES_CSS` wrapped
  the `.tsql-meta--sticky` class name in literal backticks, which closed
  the template-literal early and made the JS parser choke on the
  following text ("Unexpected identifier 'sticky'"). Replaced with plain
  text so the comments stay informative without breaking the template.
  Same class of bug as v0.2.10, v0.2.16, and v0.2.21.
- Change: `engines.tedi` raised to `>=0.3.9`. The new host API
  `ctx.tabs.setExtensionTabState` shipped in 0.3.9 is required for the
  workspace-tab tinting introduced in 0.2.24. Older hosts now refuse to
  install instead of silently running against an incompatible surface.

## [0.2.25] - 2026-05-28

- Feat: inline cell editor now picks a widget that matches the column
  type instead of always rendering a plain text input. Booleans become a
  dropdown (NULL / true / false where the column is nullable), ENUM
  columns become a dropdown of their declared options, DATE/TIME/DATETIME
  use the native HTML date / time / datetime-local pickers, integer /
  decimal columns use a `<input type="number">` with the right step, and
  JSON columns get a 3-row textarea (Shift+Enter for newlines). Binary
  cells now warn instead of opening an edit input that can't round-trip.
- Feat: table-view header reorganised to match the query-result grid.
  Left side carries `{schema.table} · {N} rows · {ms} ms`; right side
  collects every filter and action (search, column filter, Row, Reload,
  Close). The bar is sticky to the top of the results body so the
  controls follow the user when the table scrolls. Same treatment is
  applied to the free-form query result grid.
- Style: meta-bar gets a 1 px hairline divider against the table below
  it, replacing the previous border-top on `.tsql-grid-slot`. Keeps the
  divider consistent across both grids and matches TEDI core's 1 px
  separator convention.
- Style: native calendar / clock indicators inside the cell editors now
  inherit the host's foreground tint so they don't render as bright OS
  white squares on dark themes.

## [0.2.24] - 2026-05-28

- Feat: workspace tab title now tints with the active connection's
  lifecycle, mirroring the SSH tab palette. Yellow + pulse while
  connecting, green when connected, red on disconnect / error. Drives
  the new host API `ctx.tabs.setExtensionTabState(...)`; gracefully
  no-ops on older TEDI builds that lack the API.
- Style: divider line between the schema-tree search input and the
  database list so the sticky head reads as its own band.
- Style: divider line between the Run / Stop / Export toolbar and the
  query editor so the action row separates cleanly from the buffer.

## [0.2.23] - 2026-05-28

- Feat: query-result grid is paginated client-side (100 rows per page)
  so a SELECT that returns the full row_limit no longer paints
  thousands of <tr> at once. DOM stays small; pager (prev / next /
  "from-to / total") sits in the meta bar.
- Feat: HeidiSQL-style client-side search across the result rows.
  Substring match against every visible cell, debounced 160 ms. The
  table viewer keeps its existing server-side search via /table-rows
  (filter applies across the entire table, not just the loaded page).
- Feat: every result now carries an inline preview of the SQL that
  produced it, between the meta bar and the table. Single-line, full
  text in the title tooltip. Helps when a result lingers after the
  editor buffer was edited, and surfaces the sidecar-generated
  statement for table-viewer rows.
- Style: result-tab badges simplified to "{N} rows / {affected} / {ms}".
  Dropped the "#1" prefix. Single-statement runs (the common case) no
  longer show a tab strip at all; the meta bar carries the count +
  duration on its own.
- Style: splitter between editor and results now matches the host's
  PaneTreeView resize handle (bg-border/50, hover bg-primary/50 on the
  line; thicker grip in the centre). Same look and feel as the
  terminal / editor pane separators.
- Style: divider between the meta / search toolbar and the sticky
  table header so the two sections read as distinct bands.

## [0.2.22] - 2026-05-27

- Fix: MySQL "USE \`db\`" no longer fails with error 1295 ("not supported
  in the prepared statement protocol") when the user picks a database.
  The sidecar now routes the session-pin USE statement through sqlx's
  text protocol via `Executor::execute(&str)` instead of the prepared
  path. The same swap covers the Postgres `SET search_path` pin.
- Fix: SELECT queries that return 0 rows now still show their column
  headers. The sidecar preflights `prepare(sql)` and uses the cached
  statement metadata as the canonical column list; sqlx reuses the
  prepared statement for the subsequent `fetch_all`, so no extra
  round-trip. Same fix applied to the inline-edit table viewer
  (`/table-rows`) for empty tables or zero-match search filters
  (mysql / postgres / sqlite).
- Style: query-editor / results splitter now matches the host's
  `<ResizableHandle withHandle>` exactly. Grip is a 24 x 4 sharp
  rectangle in `--tedi-resize-handle` (host uses `h-6 w-1 rounded-lg`
  with TEDI's `--radius-lg: 0`, so corners are sharp there too). Hover
  no longer changes colour, matching the host's static appearance;
  focus / drag still swap line + grip to `--ring` for active feedback.

## [0.2.21] - 2026-05-27

- Fix: 0.2.20 activation crash. The new destructive-button comment in
  STYLES_CSS wrapped `<AlertDialogAction variant="destructive">` in
  literal backticks, which closed the template early and made the JS
  parser choke on the following text ("Unexpected identifier
  'variant'"). Replaced with plain text so the comment stays
  informative without breaking the template. Same class of bug as
  v0.2.10 and v0.2.16.

## [0.2.20] - 2026-05-27

Table grid search now runs through the database via `WHERE`, and the
delete affordances pick up the host's destructive chrome.

- Grid `Search rows…` input + column dropdown push to the server. The
  sidecar builds an OR-of-LIKE predicate across the supplied columns
  (or the single `search_column` when one is selected), and reports
  the matched `total` back so the pager + "N rows" header stay
  accurate as the filter narrows. LIKE metacharacters in the user-
  typed query are escaped so `a_b` matches a literal underscore.
  Search is debounced 240 ms; column change reloads immediately.
- MySQL casts non-string columns to `CHAR` and uses default collation
  for case-insensitive matching. Postgres uses `ILIKE` against
  `CAST(col AS TEXT)`. SQLite wraps both sides in `LOWER(...)` for
  Unicode-stable behaviour. Existing `order_by` continues to apply.
- Delete row-action icons (delete connection in the rail, delete row
  in the grid) now hover to a 10% --destructive tint with red text,
  matching the host's
  `text-muted-foreground hover:bg-destructive/10 hover:text-destructive`
  pattern (Settings, WorkspacesPanel, ExplorerGrep, SSH menu).
- Confirm dialog gained a `destructive: true` option; "Delete
  connection?" and "Delete row?" prompts use it, so the confirm
  button paints in --destructive instead of --primary — same chrome
  as the host's `AlertDialogAction variant="destructive"`.
- Sidecar bumped to v0.1.1; the new prebuilt
  `sidecar/windows-x86_64/tedi-sql-helper.exe` ships with the
  `search`, `search_column`, and `search_columns` request fields
  recognised by `/table-rows`.

## [0.2.19] - 2026-05-26

Right sidebar follows the left one closed on workspace open, splitter
ships a grip kotak, and the schema accordion now tracks the table the
SQL editor is referencing.

- Opening the SQL Explorer tab also collapses the right-side aux column
  (AI chat / extension right panel / SCM right panel). Mirrors the
  existing left-sidebar collapse so the workbench gets the full
  workspace width from both sides on first open. Falls through on
  hosts that predate the API (host >= 0.3.5 required for the right
  collapse; older hosts keep the previous left-only behaviour).
- Editor / results splitter now paints a visible 28x6 px grip kotak
  centred on the line so the resize affordance reads at rest, not
  only on hover. Grip + line both lift to --ring on hover / drag /
  focus, and the grip widens slightly during the drag so the user
  can see the handle is "grabbed".
- Schema accordion auto-tracks the SQL editor. As the user types,
  any `FROM`, `JOIN`, `UPDATE`, `INSERT INTO`, `DELETE FROM`,
  `TRUNCATE`, or `CREATE/ALTER/DROP TABLE` clause is parsed; if the
  referenced table lives in a cached database, that database is
  expanded (collapsing any sibling DB via the existing accordion
  rule) and the matching table row pulses + scrolls into view. The
  active database context (used by `/query` for the USE / search_path
  hint) follows the accordion, so a free-form
  `SELECT * FROM other_db.users` immediately retargets to `other_db`.
- Parser strips comments and single-quoted strings so a literal like
  `'FROM users'` inside a WHERE clause doesn't trip a false sync.
  Quoted identifiers (` `, `"`, `[`) and 1-3 level qualifiers
  (`db.schema.table`) are recognised.

## [0.2.18] - 2026-05-26

- Toolbar buttons (Stop, Export, Row, Reload, Close, etc.) no longer
  paint a visible border at rest. Border is `1px transparent` so the
  hover bg lifts to --muted as a clean kotak without an outline ring,
  matching the host's <Button variant="ghost"> chrome and the existing
  icon-button behaviour. The Run action keeps its --primary fill, and
  every button still shows --ring on focus-visible. Background also
  drops to transparent so the toolbar's card tint shows through at
  rest instead of fighting it with a slightly-different --background.

## [0.2.17] - 2026-05-26

Free-form queries now resolve unqualified tables, splitter matches the
host pane handle.

- Free-form `SELECT * FROM table` no longer errors with "1046 (3D000):
  No database selected" when the connection has no default_database
  pinned. The schema tree now tracks an active database per session:
  expanding a database (clicking the accordion header) or opening a
  table sets it as the current context. The frontend passes that
  context to `/query` and the sidecar runs `USE \`db\`` (MySQL) or
  `SET search_path TO db` (Postgres) on a pool-acquired connection
  pinned for the whole batch, so every statement sees the same session
  state. SQLite ignores the field (single-file DBs).
- Sidecar: `QueryRequest` gained an optional `database` field; falls
  back to `Connection.default_database` when the request omits it.
  Pool connection is held for the lifetime of the batch via the new
  `PinnedConn` enum so the per-statement pool checkout no longer
  drops the session setting between statements.
- Active database is highlighted in the schema tree (`.is-active`
  paints with --accent / --accent-foreground via the chrome the form
  refresh in 0.2.15 added).
- Splitter between editor and results now matches the host's
  <ResizableHandle> chrome: 1 px line in --tedi-resize-handle painted
  via ::before, with the splitter itself kept at 6 px flex-basis so
  the hit area stays drag-friendly. Hover / drag / focus swap the line
  to --ring so the active state reads the same as TEDI's pane handles.

## [0.2.16] - 2026-05-26

- Fix: 0.2.15 activation crash. A CSS comment inside the STYLES_CSS
  template literal referenced `position: relative` with literal
  backticks, which closed the template early and made the JS parser
  choke on the following text ("Unexpected identifier 'position'").
  Replaced with plain text so the comment stays informative without
  breaking the template. Same class of bug as v0.2.10.

## [0.2.15] - 2026-05-26

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

## [0.2.14] - 2026-05-26

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

## [0.2.13] - 2026-05-26

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

## [0.2.12] - 2026-05-26

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

## [0.2.11] - 2026-05-26

- Search inputs (schema rail "Search databases" + table grid "Search rows")
  now render the clear (X) button as a HugeIcon (Cancel01Icon) overlaid on
  the right edge of the input, sharing the same currentColor + hover-bg
  treatment as iconButton / textBtn / row actions. Replaces the previous
  browser-native type=search clear, which painted in the OS chrome colour
  and did not match the workbench icon family. The clear button hides
  while the input is empty and appears the moment the user types one
  character; clicking it empties the input and refocuses for fresh input.

## [0.2.10] - 2026-05-26

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

## [0.2.9] - 2026-05-26

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

## [0.2.8] - 2026-05-26

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

## [0.2.5] - 2026-05-26

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

## [0.2.4] - 2026-05-25

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

## [0.2.3] - 2026-05-25

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

## [0.2.2] - 2026-05-25

Header button + toolbar polish.

- Header button (next to SSH) now paints `Database01Icon` from
  HugeIcons via the new `hugeicon:` icon prefix, matching the host's
  SSH / Extensions / Settings buttons in stroke and color.
- Toolbar buttons (Run / Stop / Export / Reload / Row / Close / Prev /
  Next): label text is wrapped in a `<span>` so CSS `gap` rules render
  the spacing between icon and text properly. They were touching
  before because anonymous text nodes are not flex children.
- Toast on delete-row success.

## [0.2.1] - 2026-05-25

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

## [0.2.0] - 2026-05-25

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

## [0.1.0] - 2026-05-25

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
