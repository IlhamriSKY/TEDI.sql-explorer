# Changelog

All notable changes to the TEDI SQL Explorer extension are documented here.

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
